import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "../claude/sessionStore.js";
import type { AgentStreamEvent, RunHandle, RunOptions } from "../claude/runner.js";
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
      retry: vi.fn(),
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

function inbound(messageId: string, text: string): WechatInboundEvent {
  return { message: {}, messageId, conversationId: "c1", fromUserId: "u1", text,
    ack: vi.fn(), retry: vi.fn() };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function handlerFixture(
  events: () => AsyncIterable<WechatInboundEvent>,
  runAgentFn: (options: RunOptions) => RunHandle,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wechat-handler-"));
  const config = loadWechatConfig({ WECHAT_STATE_DIR: dir });
  const sessions = await SessionStore.load(config.sessionsPath);
  const sent: string[] = [];
  const client: WechatMessageClient = {
    events,
    async sendText(_event, text) { sent.push(text); },
    async startTyping() { return async () => undefined; },
    async close() {},
  };
  return { handler: new WechatHandler({ client, config, sessionStore: sessions, runAgentFn }),
    sessions, sent, client };
}

function completed(events: AgentStreamEvent[] = [], result: Awaited<RunHandle["done"]> = { exitCode: 0 }): RunHandle {
  return { events: (async function* () { yield* events; })(), done: Promise.resolve(result), kill() {} };
}

describe("WeChat turn scheduling and outcomes", () => {
  it("keeps burst messages and /new in order without silently cancelling earlier turns", async () => {
    const events = [inbound("1", "第一条"), inbound("2", "/new"), inbound("3", "第二条")];
    const run = vi.fn((_options: RunOptions) => completed([{ type: "text_delta", text: "完成", raw: {} }]));
    const { handler, sessions, sent } = await handlerFixture(async function* () { yield* events; }, run);
    await sessions.put({ threadId: "c1", sessionId: "old", createdTs: 1, lastActiveTs: 1 });
    await handler.run();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ prompt: "第一条", resumeSessionId: "old" });
    expect(run.mock.calls[1]?.[0]).toMatchObject({ resumeSessionId: undefined });
    expect(sent[1]).toContain("已开始一个新的");
    for (const event of events) expect(event.ack).toHaveBeenCalledOnce();
  });

  it("lets /stop cancel the active turn and already queued turns", async () => {
    const started = deferred();
    const aborted = deferred();
    const events = [inbound("1", "当前任务"), inbound("2", "排队任务"), inbound("3", "/stop")];
    const run = vi.fn((options: RunOptions): RunHandle => {
      options.abortSignal!.addEventListener("abort", aborted.resolve, { once: true });
      started.resolve();
      return { events: (async function* () { await aborted.promise; })(),
        done: aborted.promise.then(() => ({ exitCode: 1, termination: "interrupted" as const })), kill() {} };
    });
    const { handler } = await handlerFixture(async function* () {
      yield events[0]!;
      await started.promise;
      yield events[1]!;
      yield events[2]!;
    }, run);
    await handler.run();
    expect(run).toHaveBeenCalledOnce();
    for (const event of events) expect(event.ack).toHaveBeenCalledOnce();
  });

  it("keeps queued, unstarted turns for replay during shutdown", async () => {
    const started = deferred();
    const queued = deferred();
    const aborted = deferred();
    const endSource = deferred();
    const events = [inbound("1", "当前任务"), inbound("2", "排队任务")];
    const run = vi.fn((options: RunOptions): RunHandle => {
      options.abortSignal!.addEventListener("abort", aborted.resolve, { once: true });
      started.resolve();
      return { events: (async function* () { await aborted.promise; })(),
        done: aborted.promise.then(() => ({ exitCode: 1, termination: "interrupted" as const })), kill() {} };
    });
    const { handler } = await handlerFixture(async function* () {
      yield events[0]!;
      await started.promise;
      yield events[1]!;
      queued.resolve();
      await endSource.promise;
    }, run);
    const running = handler.run();
    await queued.promise;
    await handler.close();
    endSource.resolve();
    await running;
    expect(run).toHaveBeenCalledOnce();
    expect(events[0]!.ack).toHaveBeenCalledOnce();
    expect(events[1]!.ack).not.toHaveBeenCalled();
    expect(events[1]!.retry).toHaveBeenCalledOnce();
  });

  it("does not replay explicitly stopped queued turns when shutdown follows before the agent exits", async () => {
    const started = deferred();
    const stopped = deferred();
    const releaseAgent = deferred();
    const events = [inbound("1", "当前任务"), inbound("2", "排队任务"), inbound("3", "/stop")];
    const run = vi.fn((_options: RunOptions): RunHandle => {
      started.resolve();
      return { events: (async function* () { await releaseAgent.promise; })(),
        done: releaseAgent.promise.then(() => ({ exitCode: 1, termination: "interrupted" as const })), kill() {} };
    });
    const { handler } = await handlerFixture(async function* () {
      yield events[0]!;
      await started.promise;
      yield events[1]!;
      yield events[2]!;
      stopped.resolve();
    }, run);
    const running = handler.run();
    await stopped.promise;
    const closing = handler.close();
    releaseAgent.resolve();
    await Promise.all([running, closing]);
    expect(run).toHaveBeenCalledOnce();
    expect(events[1]!.ack).toHaveBeenCalledOnce();
    expect(events[1]!.retry).not.toHaveBeenCalled();
  });

  it.each(["timeout", "failed-result", "nonzero"] as const)("does not report %s as successful", async (outcome) => {
    const event = inbound("1", "执行任务");
    const run = vi.fn(() => completed(
      outcome === "failed-result" ? [{ type: "result", isError: true, stopReason: "failed", raw: {} }] : [],
      outcome === "timeout" ? { exitCode: 143, termination: "timeout" } : { exitCode: outcome === "nonzero" ? 2 : 0 },
    ));
    const { handler, sent } = await handlerFixture(async function* () { yield event; }, run);
    await handler.run();
    expect(sent.join("\n")).not.toContain("✅ 回复完成");
    expect(sent.join("\n")).toContain(outcome === "timeout" ? "处理超时" : "处理失败");
    expect(event.ack).toHaveBeenCalledOnce();
  });

  it("preserves a turn cancelled during typing setup before the agent has started", async () => {
    const typing = deferred();
    const releaseTyping = deferred();
    const event = inbound("1", "尚未启动的任务");
    const run = vi.fn(() => completed());
    const { handler, client } = await handlerFixture(async function* () { yield event; }, run);
    client.startTyping = async () => {
      typing.resolve();
      await releaseTyping.promise;
      return async () => undefined;
    };
    const running = handler.run();
    await typing.promise;
    const closing = handler.close();
    releaseTyping.resolve();
    await Promise.all([running, closing]);
    expect(run).not.toHaveBeenCalled();
    expect(event.ack).not.toHaveBeenCalled();
    expect(event.retry).toHaveBeenCalledOnce();
  });

  it("keeps an explicit stop during typing setup effective across shutdown", async () => {
    const typing = deferred();
    const stopped = deferred();
    const releaseTyping = deferred();
    const event = inbound("1", "尚未启动的任务");
    const stop = inbound("2", "/stop");
    const run = vi.fn(() => completed());
    const { handler, client } = await handlerFixture(async function* () {
      yield event;
      await typing.promise;
      yield stop;
      stopped.resolve();
    }, run);
    client.startTyping = async () => {
      typing.resolve();
      await releaseTyping.promise;
      return async () => undefined;
    };
    const running = handler.run();
    await stopped.promise;
    const closing = handler.close();
    releaseTyping.resolve();
    await Promise.all([running, closing]);
    expect(run).not.toHaveBeenCalled();
    expect(event.ack).toHaveBeenCalledOnce();
    expect(event.retry).not.toHaveBeenCalled();
  });

  it.each([
    ["codex exited with code 1: executable not found", false, 1],
    ["No conversation found with ID old", false, 2],
    ["No conversation found with ID old", true, 1],
  ] as const)("only retries an explicit stale session before agent progress (%s, progress=%s)", async (error, progress, calls) => {
    const event = inbound("1", "执行任务");
    const run = vi.fn((_options: RunOptions) => {
      if (run.mock.calls.length > 1) return completed();
      return { events: (async function* (): AsyncGenerator<AgentStreamEvent> {
        if (progress) yield { type: "tool_started", toolName: "exec_command", raw: {} };
        throw new Error(error);
      })(), done: Promise.resolve({ exitCode: 1 }), kill() {} };
    });
    const { handler, sessions } = await handlerFixture(async function* () { yield event; }, run);
    await sessions.put({ threadId: "c1", sessionId: "old", createdTs: 1, lastActiveTs: 1 });
    await handler.run();
    expect(run).toHaveBeenCalledTimes(calls);
    if (calls === 2) expect(run.mock.calls[1]?.[0].resumeSessionId).toBeUndefined();
  });
});
