import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { SessionStore } from "./claude/sessionStore.js";
import { installPersistentLogging } from "./logger.js";
import { ensureWechatCredentials } from "./wechat/auth.js";
import { WechatClient } from "./wechat/client.js";
import { loadWechatConfig } from "./wechat/config.js";
import { WechatHandler } from "./wechat/handler.js";
import { WechatCredentialStore, WechatDeliveryState } from "./wechat/state.js";

const VERSION = "0.1.0";

function acquireWechatLock(pidPath: string): void {
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err) {
        alive = (err as NodeJS.ErrnoException).code === "EPERM";
      }
      if (alive) {
        throw new Error(`微信 bridge 已在运行（pid ${pid}），不会启动第二个微信进程。`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("微信 bridge 已在运行")) throw err;
  }
  writeFileSync(pidPath, String(process.pid), { encoding: "utf8", mode: 0o600 });
}

function agentVersion(bin: string): string | undefined {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim().split("\n")[0];
}

function codexLoginStatus(bin: string): string | undefined {
  const result = spawnSync(bin, ["login", "status"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim() || result.stderr.trim() || "已登录";
}

async function main(): Promise<void> {
  const envFile = process.env.WECHAT_ENV_FILE?.trim() || path.resolve(".env.wechat");
  loadDotenv({ path: envFile });
  const config = loadWechatConfig();
  installPersistentLogging(config.logPath);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.workDir, { recursive: true });
  acquireWechatLock(config.pidPath);

  const version = agentVersion(config.agentBin);
  if (!version) throw new Error(`找不到 Codex CLI：${config.agentBin}。请先安装并登录，或设置 WECHAT_AGENT_BIN。`);
  const loginStatus = codexLoginStatus(config.agentBin);
  if (!loginStatus) throw new Error(`Codex CLI 尚未登录，请先运行 \`${config.agentBin} login\`。`);

  console.log(`wechat-codex-bridge ${VERSION}`);
  console.log(`  config      ${envFile}`);
  console.log(`  agent       ${version}`);
  console.log(`  auth        ${loginStatus}`);
  console.log(`  work dir    ${config.workDir}`);
  console.log(`  state       ${config.stateDir}`);
  console.log(`  log         ${config.logPath}`);
  console.log(`  sandbox     ${config.codexSandbox}`);

  const credentialStore = new WechatCredentialStore(config.credentialsPath);
  const credentials = await ensureWechatCredentials({
    config,
    store: credentialStore,
    forceLogin: process.argv.includes("--login"),
  });
  const delivery = await WechatDeliveryState.load(config.deliveryPath);
  const sessions = await SessionStore.load(config.sessionsPath, { discardExisting: true });
  const client = new WechatClient({ config, credentials, delivery });
  const handler = new WechatHandler({ client, sessionStore: sessions, config });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[wechat-codex-bridge] ${signal} — shutting down…`);
    await client.close();
    await handler.close();
    await client.flush();
    await sessions.close();
    try {
      unlinkSync(config.pidPath);
    } catch {
      // Already removed.
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log("[wechat-codex-bridge] 正在监听微信消息…");
  try {
    await handler.run();
  } finally {
    await shutdown("listener stopped");
  }
}

main().catch((err: unknown) => {
  console.error(`[wechat-codex-bridge] 启动失败：${String((err as Error).message ?? err)}`);
  process.exitCode = 1;
});
