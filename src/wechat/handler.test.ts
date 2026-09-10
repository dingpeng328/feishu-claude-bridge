import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../claude/sessionStore.js";
import type { RunOptions } from "../claude/runner.js";
import type { WechatInboundEvent, WechatMessageClient } from "./client.js";
import { loadWechatConfig } from "./config.js";
import { formatDuration, parseWechatCommand } from "./handler.js";
import { WechatHandler } from "./handler.js";

describe("WeChat handler helpers", () => {
  it("recognizes local conversation commands", () => {
    expect(parseWechatCommand(" /new ")).toBe("new");
    expect(parseWechatCommand("停止")).toBe("stop");
    expect(parseWechatCommand("状态")).toBe("status");
    expect(parseWechatCommand("普通问题")).toBeUndefined();
  });

  it("formats elapsed time", () => {
    expect(formatDuration(1_400)).toBe("1 秒");
    expect(formatDuration(65_000)).toBe("1 分 5 秒");
  });

  it("runs Codex with the WeChat-only sandbox policy and acknowledges delivery", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wechat-handler-"));
    const event: WechatInboundEvent = {
      message: {},
      messageId: "m1",
      conversationId: "c1",
      fromUserId: "u1",
      text: "检查项目",
      ack: vi.fn(),
    };
    const sent: string[] = [];
    const client: WechatMessageClient = {
      async *events() {
        yield event;
      },
      async sendText(_event, text) {
        sent.push(text);
      },
      async startTyping() {
        return async () => undefined;
      },
      async close() {},
    };
    const runAgentFn = vi.fn((_options: RunOptions) => ({
      events: (async function* () {
        yield { type: "system_init", sessionId: "codex-thread-1", raw: {} } as const;
        yield { type: "text_delta", text: "检查完成", raw: {} } as const;
      })(),
      done: Promise.resolve({ exitCode: 0, sessionId: "codex-thread-1" }),
      kill() {},
    }));
    const config = loadWechatConfig({
      WECHAT_STATE_DIR: dir,
      WECHAT_WORK_DIR: path.join(dir, "work"),
      WECHAT_CODEX_SANDBOX: "workspace-write",
      WECHAT_CODEX_APPROVE_FOR_ME: "true",
    });
    const sessions = await SessionStore.load(config.sessionsPath, { discardExisting: true });
    await new WechatHandler({ client, sessionStore: sessions, config, runAgentFn }).run();

    expect(runAgentFn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: "codex",
        codexExecutionPolicy: {
          mode: "sandbox",
          sandbox: "workspace-write",
          approveForMe: true,
        },
      }),
    );
    expect(sent.at(-1)).toContain("✅ 回复完成");
    expect(event.ack).toHaveBeenCalledOnce();
    expect(sessions.get("c1")?.sessionId).toBe("codex-thread-1");
  });
});
