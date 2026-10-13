import "dotenv/config"
import { execFileSync } from "child_process"
import { existsSync } from "fs"
import process from "process"

import { startBot } from "./im/lark"
import { version, engines } from "../package.json"

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
    console.log(
      `[收到] chat=${msg.chatId} type=${msg.chatType} sender=${msg.senderOpenId} 内容: ${msg.text}`,
    )
    const replyId = await bot.reply(
      msg.messageId,
      `<at user_id="${process.env.OWNER_OPEN_ID}"></at> 收到，这条是点名回复`,
    )
    console.log(`[已回] message_id=${replyId}`)
  },
})
