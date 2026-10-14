import "dotenv/config"
import { execFileSync } from "child_process"
import { existsSync } from "fs"
import process from "process"
import { join } from "path"

import { version, engines } from "../package.json"
import { Bot, startBot } from "./im/lark"
import { extractResourceKeys, resolveMentions } from "./im/message-parser"
import { buildTaskCard, ThrottledCardUpdater } from "./im/card"

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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
): Promise<void> {
  const activities: string[] = []
  const updater = new ThrottledCardUpdater(async (card) => {
    await bot.updateCard(cardId, card)
    console.log(`[卡片] 已刷新`)
  })

  for (const [index, step] of DEMO_STEPS.entries()) {
    await wait(700)
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

startBot({
  appId,
  appSecret,
  onMessage: async (msg, bot) => {
    const resolved = resolveMentions(msg.text, msg.mentions)
    console.log(
      `[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`,
    )
    console.log(`  原文: ${msg.text}`)
    console.log(`  还原: ${resolved}`)
    console.log(
      `  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(", ") || "(无)"}`,
    )

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

    const hasThread = !!msg.threadId || !!msg.rootId
    const cardId = await bot.replyCard(
      msg.messageId,
      buildTaskCard({
        title: "Naive Agent OS 模拟任务",
        status: "running",
        progress: 0,
        detail: "正在准备任务环境",
      }),
      hasThread,
    )
    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`)

    if (!cardId) {
      console.error("[卡片] 响应里没有 message_id，无法继续更新")
      return
    }
    console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`)

    // 让事件回调尽快返回，后续模拟更新在后台继续。
    void runCardDemo(bot, cardId, resolved).catch((error) => {
      console.error("[卡片] 演示失败:", (error as Error).message)
    })
  },
})
