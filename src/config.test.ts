import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const ENV_KEYS = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_BOT_OPEN_ID",
  "ALLOWED_CHAT_IDS",
  "WORK_DIR",
  "AGENT_KIND",
  "AGENT_BIN",
  "AGENT_SYSTEM_PROMPT",
  "CLAUDE_BIN",
  "SUBPROCESS_TIMEOUT_MS",
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setMinimalEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.FEISHU_APP_ID = "cli_test";
  process.env.FEISHU_APP_SECRET = "secret_test";
}

describe("loadConfig", () => {
  it("infers codex when AGENT_BIN points at codex", () => {
    setMinimalEnv();
    process.env.AGENT_BIN = "codex";

    const config = loadConfig();

    expect(config.agentKind).toBe("codex");
    expect(config.agentBin).toBe("codex");
  });

  it("keeps explicit AGENT_KIND authoritative", () => {
    setMinimalEnv();
    process.env.AGENT_KIND = "claude";
    process.env.AGENT_BIN = "codex";

    const config = loadConfig();

    expect(config.agentKind).toBe("claude");
    expect(config.agentBin).toBe("codex");
  });

  it("uses the built-in system prompt by default", () => {
    setMinimalEnv();

    expect(loadConfig().agentSystemPrompt).toContain("通过飞书话题和用户对话的助手");
  });

  it("loads a custom multi-line system prompt from the environment", () => {
    setMinimalEnv();
    process.env.AGENT_SYSTEM_PROMPT = "你是发布助手。\n先给结论，再给依据。";

    expect(loadConfig().agentSystemPrompt).toBe("你是发布助手。\n先给结论，再给依据。");
  });
});
