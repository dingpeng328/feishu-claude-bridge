import os from "node:os";
import path from "node:path";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_API_BASE_URL = "https://ilinkai.weixin.qq.com";

const BooleanString = z
  .string()
  .optional()
  .transform((value) => value == null || !["0", "false", "no", "off"].includes(value.toLowerCase()));

const EnvSchema = z.object({
  WECHAT_WORK_DIR: z.string().optional(),
  WECHAT_AGENT_BIN: z.string().optional(),
  WECHAT_AGENT_SYSTEM_PROMPT: z.string().optional(),
  WECHAT_SUBPROCESS_TIMEOUT_MS: z.string().optional(),
  WECHAT_CODEX_SANDBOX: z.enum(["read-only", "workspace-write"]).optional(),
  WECHAT_CODEX_APPROVE_FOR_ME: BooleanString,
  WECHAT_API_BASE_URL: z.string().url().optional(),
  WECHAT_BOT_TYPE: z.string().optional(),
  WECHAT_BOT_AGENT: z.string().optional(),
  WECHAT_STATE_DIR: z.string().optional(),
});

export interface WechatConfig {
  workDir: string;
  agentBin: string;
  agentSystemPrompt: string;
  subprocessTimeoutMs: number;
  codexSandbox: "read-only" | "workspace-write";
  codexApproveForMe: boolean;
  apiBaseUrl: string;
  botType: string;
  botAgent: string;
  stateDir: string;
  credentialsPath: string;
  deliveryPath: string;
  sessionsPath: string;
  pidPath: string;
  logPath: string;
}

export const DEFAULT_WECHAT_AGENT_SYSTEM_PROMPT = [
  "你是一个通过微信 ClawBot 与用户对话的本地 Codex 助手。",
  "请自然、简洁地用中文回复；需要时可以在指定工作目录中读取、修改文件和执行命令。",
  "不要声称已经完成未实际验证的操作；涉及删除、发布、推送或生产写入时，先说明影响并等待用户明确确认。",
].join("\n");

export function loadWechatConfig(env: NodeJS.ProcessEnv = process.env): WechatConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid WeChat configuration:\n${issues}\n\n复制 .env.wechat.example 为 .env.wechat 后再启动。`);
  }
  const values = parsed.data;
  const stateDir = path.resolve(
    values.WECHAT_STATE_DIR?.trim() || path.join(os.homedir(), ".wechat-codex-bridge"),
  );
  const timeout = values.WECHAT_SUBPROCESS_TIMEOUT_MS
    ? Number(values.WECHAT_SUBPROCESS_TIMEOUT_MS)
    : NaN;
  const codexSandbox = values.WECHAT_CODEX_SANDBOX ?? "workspace-write";

  return {
    workDir: path.resolve(values.WECHAT_WORK_DIR?.trim() || path.join(stateDir, "work")),
    agentBin: values.WECHAT_AGENT_BIN?.trim() || "codex",
    agentSystemPrompt:
      values.WECHAT_AGENT_SYSTEM_PROMPT === undefined
        ? DEFAULT_WECHAT_AGENT_SYSTEM_PROMPT
        : values.WECHAT_AGENT_SYSTEM_PROMPT.trim(),
    subprocessTimeoutMs:
      Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    codexSandbox,
    // --approve-for-me is itself a workspace-write policy in current Codex and
    // cannot be combined with --sandbox. read-only therefore always disables it.
    codexApproveForMe: codexSandbox === "workspace-write" && values.WECHAT_CODEX_APPROVE_FOR_ME,
    apiBaseUrl: values.WECHAT_API_BASE_URL ?? DEFAULT_API_BASE_URL,
    botType: values.WECHAT_BOT_TYPE?.trim() || "3",
    botAgent: values.WECHAT_BOT_AGENT?.trim() || "WechatCodexBridge/0.1.0",
    stateDir,
    credentialsPath: path.join(stateDir, "account.json"),
    deliveryPath: path.join(stateDir, "delivery-state.json"),
    sessionsPath: path.join(stateDir, "sessions.json"),
    pidPath: path.join(stateDir, "bridge.pid"),
    logPath: path.join(stateDir, "bridge.log"),
  };
}
