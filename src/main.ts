/**
 * src/main.ts
 *
 * Entry point: load config → wire ChannelClient + SessionStore + CardRenderer +
 * BridgeHandler → run the main loop. Graceful shutdown on SIGINT/SIGTERM.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { ChannelClient } from "./lark/channel.js";
import { CardRenderer } from "./lark/card.js";
import { SessionStore } from "./claude/sessionStore.js";
import { BridgeHandler } from "./bridge/handler.js";
import { installPersistentLogging } from "./logger.js";

const VERSION = "0.1.0";

/**
 * Single-instance lock. The SAME Feishu app may hold only ONE long-connection
 * slot — two bridges on one app endlessly evict each other (a "reconnect storm"
 * that drops inbound messages). This pid lock refuses to start a second instance
 * on this machine. Returns the pid path so shutdown() can remove it.
 */
function acquireSingleInstanceLock(pidPath: string): string {
  try {
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      let alive = false;
      try {
        process.kill(pid, 0); // signal 0 = liveness probe (throws if dead)
        alive = true;
      } catch (e) {
        // EPERM = exists but not ours (still alive); ESRCH = dead (stale file).
        alive = (e as NodeJS.ErrnoException).code === "EPERM";
      }
      if (alive) {
        console.error(
          `[feishu-claude-bridge] 已有 bridge 实例在运行 (pid ${pid}) — 拒绝启动第二个。\n` +
            `  同一飞书 app 只能一处长连接;多实例会互相挤掉对方(reconnect 风暴,消息收不到)。\n` +
            `  先停掉那个实例,或就用它。若确认 pid ${pid} 已死,删除 ${pidPath} 再重试。`,
        );
        process.exit(1);
      }
    }
  } catch {
    // pid file absent → first instance, proceed.
  }
  writeFileSync(pidPath, String(process.pid), "utf8");
  return pidPath;
}

function checkAgent(bin: string): string | null {
  try {
    return execSync(`${bin} --version`, { stdio: ["pipe", "pipe", "pipe"] })
      .toString()
      .trim()
      .split("\n")[0] ?? "";
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[feishu-claude-bridge] ${(err as Error).message}`);
    process.exit(1);
  }

  installPersistentLogging(config.logPath);

  console.log(`feishu-claude-bridge ${VERSION}\n`);

  // Ensure the state home (sessions.json + bridge.pid) exists.
  mkdirSync(path.dirname(config.pidPath), { recursive: true });
  // Refuse to start a second instance (same Feishu app = one WS slot only).
  const pidPath = acquireSingleInstanceLock(config.pidPath);

  const agentVersion = checkAgent(config.agentBin);
  if (agentVersion) {
    console.log(`  agent      ✓  ${config.agentKind} (${agentVersion})`);
  } else {
    console.warn(`  agent      ✗  (未找到 "${config.agentBin}" — 装好 ${config.agentKind} CLI 并确保在 PATH,或设 AGENT_BIN)`);
  }
  console.log(`  work dir    ${config.workDir}`);
  console.log(`  sessions    ${config.sessionsPath}`);
  console.log(`  delivery    ${config.deliveryPath}`);
  console.log(`  log         ${config.logPath}`);
  console.log(
    `  chats       ${config.allowedChatIds.size > 0 ? [...config.allowedChatIds].join(", ") : "(所有群)"}\n`,
  );

  mkdirSync(config.workDir, { recursive: true });

  const client = new ChannelClient({
    appId: config.appId,
    appSecret: config.appSecret,
    allowedChatIds: config.allowedChatIds,
    deliveryStatePath: config.deliveryPath,
  });
  const sessionStore = await SessionStore.load(config.sessionsPath);
  const cardRenderer = new CardRenderer({
    outbound: client.outboundCardClient(),
  });
  const handler = new BridgeHandler({
    client,
    cardRenderer,
    sessionStore,
    workDir: config.workDir,
    agentKind: config.agentKind,
    agentBin: config.agentBin,
    agentSystemPrompt: config.agentSystemPrompt,
    subprocessTimeoutMs: config.subprocessTimeoutMs,
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[feishu-claude-bridge] ${signal} — shutting down…`);
    await handler.close();
    await client.close();
    await sessionStore.close();
    try {
      unlinkSync(pidPath);
    } catch {
      /* already gone */
    }
    console.log("[feishu-claude-bridge] bye.");
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log("[feishu-claude-bridge] listening for @-mentions…\n");
  await handler.run();
}

main().catch((err: unknown) => {
  console.error("[feishu-claude-bridge] startup failed:", err);
  process.exit(1);
});
