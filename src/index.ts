import "dotenv/config"
import { execFileSync } from "child_process"
import { existsSync } from "fs"
import process from "process"
import { join } from "path"

import { version, engines } from "../package.json"
import { Bot, startBot } from "./im/lark"
import { extractResourceKeys, resolveMentions } from "./im/message-parser"
import { buildTaskCard, ThrottledCardUpdater } from "./im/card"
import { SessionManager, type Session } from "./core/session-manager"
import { parseCommand } from "./core/command-parser"

const appId = process.env.BOT_A_APP_ID
const appSecret = process.env.BOT_A_APP_SECRET

function hasCommand(cmd: string) {
  try {
    if (process.platform === "win32") {
      execFileSync("where.exe", ["/q", cmd], { stdio: "ignore" })
    } else {
      execFileSync(
        "/bin/sh",
        ["-c", `command -v "$1"`, "naive-agent-os", cmd],
        { stdio: "ignore" },
      )
    }
    return true
  } catch {
    return false
  }
}

function check(label: string, ok: boolean, hint: string) {
  console.log(`  ${ok ? "✅" : "⚠️ "} ${label}${ok ? "" : `  → ${hint}`}`)
}

console.log(`\nNaive Agent OS v${version} - 一个人，一队 Agent \n`)
console.log("环境自检: ")

const nodeMajor = Number(process.versions.node.split(".")[0])
const requiredNodeMajor = Number.parseInt(engines.node.slice(2))

check(
  `Node.js ${process.versions.node}`,
  nodeMajor >= requiredNodeMajor,
  `需要 Node ${requiredNodeMajor}+`,
)
check(
  ".env 配置文件",
  existsSync(".env"),
  "复制 .env.example 为 .env 并填入飞书凭证",
)
check(
  "Claude Code CLI",
  hasCommand("claude"),
  "接入 CLI 前需要安装；无 Anthropic 订阅可使用 DeepSeek",
)
check("Codex CLI", hasCommand("codex"), "后续接入 Codex 前再安装")
check("Dimcode", hasCommand("dim"), "后续接入 Dimcode 前再安装")

if (!appId || !appSecret) {
  console.error("缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env")
  process.exit(1)
}

console.log("Naive Agent OS 启动，正在建立飞书长连接")

const sessions = new SessionManager()
const activeRuns = new Map<string, AbortController>()

function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stopWaiting)
      resolve(true)
    }, ms)
    const stopWaiting = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener("abort", stopWaiting, { once: true })
  })
}

const DEMO_STEPS = [
  "读取项目结构",
  "定位任务入口",
  "分析相关文件",
  "生成修改方案",
  "写入代码改动",
  "检查类型错误",
  "运行验证命令",
  "整理执行结果",
]

async function runCardDemo(
  bot: Bot,
  cardId: string,
  resolved: string,
  signal: AbortSignal,
): Promise<void> {
  const activities: string[] = []
  const updater = new ThrottledCardUpdater(async (card) => {
    await bot.updateCard(cardId, card)
    console.log(`[卡片] 已刷新`)
  })

  for (const [index, step] of DEMO_STEPS.entries()) {
    if (!(await wait(700, signal))) {
      await updater.cancel()
      console.log("[卡片] 任务已取消")
      return
    }
    activities.push(step)
    const progress = Math.round(((index + 1) / DEMO_STEPS.length) * 90)
    console.log(`[进度] ${progress}% ${step}`)
    updater.push(
      buildTaskCard({
        title: "Naive Agent OS 模拟任务",
        status: "running",
        progress,
        detail: step,
        activities: activities.slice(-3),
      }),
    )
  }

  await updater.finish(
    buildTaskCard({
      title: "Naive Agent OS 模拟任务",
      status: "success",
      progress: 100,
      detail: `已处理：${resolved || "富媒体消息"}`,
      activities: activities.slice(-3),
    }),
  )
  console.log("[卡片] 任务完成")
}

function markSessionIdle(sessionId: string): void {
  if (sessions.get(sessionId)?.status !== "active") return
  sessions.transition(sessionId, "idle")
  console.log(`[会话] id=${sessionId} status=idle`)
}

const STATUS_LABELS: Record<Session["status"], string> = {
  creating: "创建中",
  active: "执行中",
  idle: "空闲",
  closed: "已关闭",
}

function formatSessionStatus(session: Session): string {
  return [
    `会话：${session.id}`,
    `状态：${STATUS_LABELS[session.status]}`,
    `执行引擎：${session.cliId}`,
    `话题：${session.threadId}`,
    `更新时间：${session.updatedAt}`,
  ].join("\n")
}

startBot({
  appId,
  appSecret,
  onMessage: async (msg, bot) => {
    const resolved = resolveMentions(msg.text, msg.mentions)
    const hasThread = !!msg.threadId || !!msg.rootId
    const { session, isNew } = sessions.resolve(msg)

    console.log(
      `[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`,
    )
    console.log(`  原文: ${msg.text}`)
    console.log(`  还原: ${resolved}`)
    console.log(
      `  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(", ") || "(无)"}`,
    )
    console.log(
      `  [会话] ${isNew ? "新建" : "复用"} id=${session.id} status=${session.status}`,
    )

    const command = parseCommand(resolved)

    if (command?.name === "help") {
      await bot.reply(
        msg.messageId,
        ["/status 查看当前会话", "/close 关闭当前会话", "/help 查看命令"].join(
          "\n",
        ),
        hasThread,
      )
      return
    }

    if (command?.name === "status") {
      await bot.reply(msg.messageId, formatSessionStatus(session), hasThread)
      return
    }

    if (command?.name === "close") {
      activeRuns.get(session.id)?.abort()
      if (session.status !== "closed") sessions.transition(session.id, "closed")
      await bot.reply(
        msg.messageId,
        "当前会话已关闭。需要继续时，请新开一个话题。",
        hasThread,
      )
      return
    }

    if (session.status === "closed") {
      await bot.reply(
        msg.messageId,
        "这个话题的会话已经关闭，请新开一个话题继续。",
        hasThread,
      )
      return
    }

    if (session.status === "active") {
      await bot.reply(
        msg.messageId,
        "当前会话还在执行，请等任务结束后再追问。",
        hasThread,
      )
      return
    }

    sessions.transition(session.id, "active")
    const run = new AbortController()
    activeRuns.set(session.id, run)

    // 图片/文件下载
    const resources = extractResourceKeys(msg.messageType, msg.rawContent)
    for (const res of resources) {
      try {
        const savePath = await bot.downloadResource(
          msg.messageId,
          res.key,
          res.type,
          join("data", "downloads"),
          res.fileName,
        )
        console.log(`  [下载] ${res.type} → ${savePath}`)
      } catch (e) {
        console.error(`  [下载失败] ${res.key}:`, (e as Error).message)
      }
    }

    // 先回复一张卡片，后续更新复用同一个 message_id
    let cardId: string | undefined
    try {
      cardId = await bot.replyCard(
        msg.messageId,
        buildTaskCard({
          title: "Naive Agent OS 模拟任务",
          status: "running",
          progress: 0,
          detail: "正在准备任务环境",
        }),
        hasThread,
      )
    } catch (error) {
      if (activeRuns.get(session.id) === run) activeRuns.delete(session.id)
      markSessionIdle(session.id)
      throw error
    }

    if (!cardId) {
      console.error("[卡片] 响应里没有 message_id，无法继续更新")
      if (activeRuns.get(session.id) === run) activeRuns.delete(session.id)
      markSessionIdle(session.id)
      return
    }

    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`)

    if (!cardId) {
      console.error("[卡片] 响应里没有 message_id，无法继续更新")
      return
    }
    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`)

    // 让事件回调尽快返回，后续模拟更新在后台继续。
    void runCardDemo(bot, cardId, resolved, run.signal)
      .catch((error) => {
        console.error("[卡片] 演示失败:", (error as Error).message)
      })
      .finally(() => {
        if (activeRuns.get(session.id) === run) activeRuns.delete(session.id)
        markSessionIdle(session.id)
      })
  },
})
