import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { config as loadDotenv } from "dotenv";
import { HistoryReader } from "./history/store.js";
import { startHistoryServer } from "./history/server.js";

async function main() {
  const { values } = parseArgs({ options: {
    port: { type: "string", default: "8765" },
    dir: { type: "string", multiple: true },
  } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port 必须介于 1 和 65535");
  // Only the WeChat state location is needed; never start a bridge or read credentials.
  const wechatEnv = loadDotenv({ path: process.env.WECHAT_ENV_FILE || ".env.wechat", processEnv: {} }).parsed;
  const wechatState = process.env.WECHAT_STATE_DIR || wechatEnv?.WECHAT_STATE_DIR || path.join(os.homedir(), ".wechat-codex-bridge");
  const directories = [...new Set((values.dir ?? [
    path.join(os.homedir(), ".feishu-claude-bridge", "history"),
    path.join(wechatState, "history"),
  ]).map(dir => path.resolve(dir)))];
  const { server, url } = await startHistoryServer(new HistoryReader(directories), port);
  console.log(`本地会话与执行过程：${url}\n记录目录：\n${directories.join("\n")}\n按 Ctrl+C 关闭查看器。`);
  const stop = () => { server.close(); server.closeAllConnections(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
main().catch(err => {
  console.error(`[history] ${err.code === "EADDRINUSE" ? "端口已占用，请用 --port 指定其他端口。" : String(err)}`);
  process.exitCode = 1;
});
