/**
 * src/config.ts
 *
 * Loads + validates configuration from environment (.env via dotenv).
 * The only hard requirements are the Feishu app credentials; everything else
 * has a sane default so a minimal .env is enough to run.
 */

import os from "node:os";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./claude/prompt.js";

// Load .env into process.env (no-op if the file is absent).
loadDotenv();

/** Stable state home — sessions.json + bridge.pid live here, never under workDir. */
const HOME_DIR = path.join(os.homedir(), ".feishu-claude-bridge");
const DEFAULT_WORK_DIR = path.join(HOME_DIR, "work");
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

const EnvSchema = z.object({
  FEISHU_APP_ID: z.string().min(1, "FEISHU_APP_ID is required"),
  FEISHU_APP_SECRET: z.string().min(1, "FEISHU_APP_SECRET is required"),
  FEISHU_BOT_OPEN_ID: z.string().optional(),
  ALLOWED_CHAT_IDS: z.string().optional(),
  WORK_DIR: z.string().optional(),
  AGENT_KIND: z.enum(["claude", "codex"]).optional(),
  AGENT_BIN: z.string().optional(),
  AGENT_SYSTEM_PROMPT: z.string().optional(),
  CLAUDE_BIN: z.string().optional(),
  SUBPROCESS_TIMEOUT_MS: z.string().optional(),
});

export interface Config {
  appId: string;
  appSecret: string;
  /** Bot's own open_id — display/logging only. */
  botOpenId: string;
  /** Allowed group chat_ids; empty set = respond in any group. */
  allowedChatIds: Set<string>;
  /** Shared cwd the agent subprocess runs in (same for all topics). */
  workDir: string;
  /** Path to the sessions.json persistence file (stable, under HOME_DIR). */
  sessionsPath: string;
  /** Single-instance lock file path (stable, under HOME_DIR). */
  pidPath: string;
  /** Durable delivery cursor + mention-id ledger (stable, under HOME_DIR). */
  deliveryPath: string;
  /** Persistent runtime log (stable, under HOME_DIR). */
  logPath: string;
  agentKind: "claude" | "codex";
  agentBin: string;
  /** Role/behavior instructions prepended when a new agent session starts. */
  agentSystemPrompt: string;
  subprocessTimeoutMs: number;
}

/**
 * Parse + validate process.env into a typed Config. Throws a readable error
 * (collected zod issues) when a required field is missing — main.ts surfaces it.
 */
export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}\n\n复制 .env.example 为 .env 并填好凭证。`);
  }
  const env = parsed.data;

  const allowedChatIds = new Set(
    (env.ALLOWED_CHAT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

  const workDir = env.WORK_DIR && env.WORK_DIR.trim() ? env.WORK_DIR.trim() : DEFAULT_WORK_DIR;

  const timeout = env.SUBPROCESS_TIMEOUT_MS ? Number(env.SUBPROCESS_TIMEOUT_MS) : NaN;
  const subprocessTimeoutMs =
    Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
  const configuredAgentBin =
    env.AGENT_BIN && env.AGENT_BIN.trim()
      ? env.AGENT_BIN.trim()
      : env.CLAUDE_BIN && env.CLAUDE_BIN.trim()
        ? env.CLAUDE_BIN.trim()
        : undefined;
  const inferredAgentKind =
    env.AGENT_KIND ??
    (configuredAgentBin != null && path.basename(configuredAgentBin).includes("codex")
      ? "codex"
      : "claude");

  return {
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    botOpenId: env.FEISHU_BOT_OPEN_ID ?? "",
    allowedChatIds,
    workDir,
    // State files live under a STABLE home dir, never under workDir — so pointing
    // workDir at a project repo doesn't drop sessions.json / bridge.pid into it.
    sessionsPath: path.join(HOME_DIR, "sessions.json"),
    pidPath: path.join(HOME_DIR, "bridge.pid"),
    deliveryPath: path.join(HOME_DIR, "delivery-state.json"),
    logPath: path.join(HOME_DIR, "bridge.log"),
    agentKind: inferredAgentKind,
    agentBin: configuredAgentBin ?? (inferredAgentKind === "codex" ? "codex" : "claude"),
    agentSystemPrompt:
      env.AGENT_SYSTEM_PROMPT === undefined
        ? DEFAULT_AGENT_SYSTEM_PROMPT
        : env.AGENT_SYSTEM_PROMPT.trim(),
    subprocessTimeoutMs,
  };
}
