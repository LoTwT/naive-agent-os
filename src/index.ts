import "dotenv/config"
import { execFileSync } from "child_process"
import { existsSync } from "fs"
import process from "process"

import { version, engines } from "../package.json"
import { startBot } from "./im/lark"
import { extractResourceKeys, resolveMentions } from "./im/message-parser"
import { join } from "path"

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
    const replyId = await bot.reply(
      msg.messageId,
      `收到：${resolved}`,
      hasThread,
    )
    console.log(`[已回] message_id=${replyId} inThread=${hasThread}`)
  },
})
