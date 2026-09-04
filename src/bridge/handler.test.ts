import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentStreamEvent, RunHandle } from "../claude/runner.js";

// Mock the runner so no real agent subprocess is spawned.
const runAgentMock = vi.fn();
vi.mock("../claude/runner.js", () => ({ runAgent: (opts: unknown) => runAgentMock(opts) }));

import { BridgeHandler } from "./handler.js";
import type { LarkMessageEvent } from "../lark/transport.js";
import type { ThreadContextMessage } from "../lark/channel.js";
import { SessionStore } from "../claude/sessionStore.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A RunHandle that streams the given events then resolves done. */
function fakeRun(events: AgentStreamEvent[], exitCode = 0, sessionId = "sess_new"): RunHandle {
  async function* gen(): AsyncGenerator<AgentStreamEvent> {
    for (const e of events) yield e;
  }
  return { events: gen(), done: Promise.resolve({ exitCode, sessionId }), kill: () => {} };
}

/** A RunHandle whose done rejects (e.g. claude exited with "No conversation found"). */
function failingRun(message: string): RunHandle {
  async function* gen(): AsyncGenerator<AgentStreamEvent> {
    // no events
  }
  const done = Promise.reject(new Error(message));
  // Suppress the global "unhandled rejection" flag (created before the handler
  // awaits it). The original promise still rejects for the handler's `await`.
  done.catch(() => {});
  return { events: gen(), done, kill: () => {} };
}

interface FakeCard {
  handled: AgentStreamEvent[];
  finalizeArgs: unknown;
}

function makeDeps(events: LarkMessageEvent[]) {
  const card: FakeCard = { handled: [], finalizeArgs: undefined };
  const cardRenderer = {
    start: vi.fn(async () => ({
      messageId: "om_card",
      handle: (e: AgentStreamEvent) => card.handled.push(e),
      finalize: async (a: unknown) => {
        card.finalizeArgs = a;
      },
    })),
  };
  const client = {
    getBotSenderIds: vi.fn(() => ["cli_bot", "ou_bot"]),
    getThreadContext: vi.fn(async (): Promise<ThreadContextMessage[]> => []),
    async *events(): AsyncIterable<LarkMessageEvent> {
      for (const e of events) yield e;
    },
  };
  return { card, cardRenderer, client };
}

let store: SessionStore;
let workDir: string;
beforeEach(async () => {
  runAgentMock.mockReset();
  const dir = await mkdtemp(path.join(tmpdir(), "fcb-h-"));
  store = await SessionStore.load(path.join(dir, "sessions.json"));
  workDir = path.join(dir, "work");
});

function topEvent(text: string): LarkMessageEvent {
  return {
    message_id: "om_top",
    chat_id: "oc_1",
    chat_type: "group",
    sender_id: "ou_s",
    mentioned_bot: true,
    content: JSON.stringify({ text }),
    create_time: "1",
  };
}

/** Poll until cond() is truthy (run() returns before in-flight turns finish). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeHandler(deps: ReturnType<typeof makeDeps>) {
  return new BridgeHandler({
    client: deps.client as never,
    cardRenderer: deps.cardRenderer as never,
    sessionStore: store,
    workDir,
    agentKind: "claude",
    agentBin: "claude",
    agentSystemPrompt: "测试助手提示词",
    subprocessTimeoutMs: 1000,
  });
}

describe("BridgeHandler.handleOne", () => {
  it("ignores a new top-level message that does not mention the bot", async () => {
    runAgentMock.mockReturnValue(
      fakeRun([{ type: "text_delta", text: "should not run", raw: {} }]),
    );
    const deps = makeDeps([{ ...topEvent("路过闲聊"), mentioned_bot: false }]);
    await makeHandler(deps).run();

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(deps.cardRenderer.start).not.toHaveBeenCalled();
  });

  it("still handles a direct message without requiring an @mention", async () => {
    runAgentMock.mockReturnValue(
      fakeRun([{ type: "text_delta", text: "私聊回复", raw: { message: { id: "m1" } } }]),
    );
    const deps = makeDeps([{ ...topEvent("私聊问题"), chat_type: "p2p", mentioned_bot: false }]);
    await makeHandler(deps).run();
    await waitFor(() => deps.card.finalizeArgs !== undefined);

    expect(runAgentMock).toHaveBeenCalledOnce();
    expect(deps.card.finalizeArgs).toMatchObject({ success: true, finalText: "私聊回复" });
  });

  it("streams to card, finalizes success, persists sessionId", async () => {
    runAgentMock.mockReturnValue(
      fakeRun([
        { type: "system_init", sessionId: "sess_new", raw: {} },
        { type: "text_delta", text: "答案是 4", raw: { message: { id: "m1" } } },
      ]),
    );
    const deps = makeDeps([topEvent("2+2?")]);
    await makeHandler(deps).run();
    await waitFor(() => deps.card.finalizeArgs !== undefined);

    expect(deps.cardRenderer.start).toHaveBeenCalledWith("oc_1", "om_top", {
      replyInThread: true,
    });
    expect(deps.card.finalizeArgs).toMatchObject({ success: true, finalText: "答案是 4" });
    expect(store.get("om_top")?.sessionId).toBe("sess_new");
  });

  it("pulls the whole group topic before answering an in-thread @mention", async () => {
    runAgentMock.mockReturnValue(
      fakeRun([{ type: "text_delta", text: "综合回复", raw: { message: { id: "m1" } } }]),
    );
    const current = inThreadReply("om_3", "om_root", "请综合一下", true);
    const deps = makeDeps([current]);
    deps.client.getThreadContext.mockResolvedValue([
      {
        messageId: "om_root",
        senderId: "ou_a",
        createTime: "1",
        msgType: "text",
        text: "背景：发布失败",
      },
      {
        messageId: "om_2",
        senderId: "ou_b",
        createTime: "2",
        msgType: "text",
        text: "普通讨论，没有 @ 机器人",
      },
      {
        messageId: "om_3",
        senderId: "ou_s",
        createTime: "3",
        msgType: "text",
        text: "请综合一下",
      },
    ]);

    await makeHandler(deps).run();
    await waitFor(() => deps.card.finalizeArgs !== undefined);

    expect(deps.client.getThreadContext).toHaveBeenCalledWith("omt_x", "om_root", current);
    const prompt = String(runAgentMock.mock.calls[0]?.[0]?.prompt);
    expect(prompt).toContain("背景：发布失败");
    expect(prompt).toContain("普通讨论，没有 @ 机器人");
    expect(prompt).toContain("请综合全部讨论，重点回答当前消息");
    expect(deps.card.finalizeArgs).toMatchObject({ success: true, finalText: "综合回复" });
  });

  it("skips a replay when this bot already replied after the same topic message", async () => {
    runAgentMock.mockReturnValue(
      fakeRun([{ type: "text_delta", text: "不应重复执行", raw: {} }]),
    );
    const current = {
      ...inThreadReply("om_replayed", "om_root", "请处理", true),
      recovered_from_history: true,
      create_time: "2000",
    };
    const deps = makeDeps([current]);
    deps.client.getThreadContext.mockResolvedValue([
      {
        messageId: "om_replayed",
        senderId: "ou_user",
        createTime: "2000",
        msgType: "text",
        text: "请处理",
      },
      {
        messageId: "om_answered_elsewhere",
        senderId: "cli_bot",
        createTime: "3000",
        msgType: "interactive",
        cardStatus: "success",
        text: "已经处理完成",
      },
    ]);

    await makeHandler(deps).run();
    await waitFor(() => deps.client.getThreadContext.mock.calls.length === 1);

    expect(deps.client.getThreadContext).toHaveBeenCalledOnce();
    expect(deps.cardRenderer.start).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("does not treat an unfinished bot card as already handled", async () => {
    runAgentMock.mockReturnValue(
      fakeRun([{ type: "text_delta", text: "重新处理完成", raw: {} }]),
    );
    const current = {
      ...inThreadReply("om_replayed", "om_root", "请处理", true),
      recovered_from_history: true,
      create_time: "2000",
    };
    const deps = makeDeps([current]);
    deps.client.getThreadContext.mockResolvedValue([
      {
        messageId: "om_replayed",
        senderId: "ou_user",
        createTime: "2000",
        msgType: "text",
        text: "请处理",
      },
      {
        messageId: "om_stuck_card",
        senderId: "cli_bot",
        createTime: "3000",
        msgType: "interactive",
        cardStatus: "thinking",
        text: "思考中",
      },
    ]);

    await makeHandler(deps).run();
    await waitFor(() => deps.card.finalizeArgs !== undefined);

    expect(deps.cardRenderer.start).toHaveBeenCalledOnce();
    expect(runAgentMock).toHaveBeenCalledOnce();
    expect(deps.card.finalizeArgs).toMatchObject({ success: true, finalText: "重新处理完成" });
  });

  it("handles a newer mention when this bot only replied earlier in the topic", async () => {
    runAgentMock.mockReturnValue(
      fakeRun([{ type: "text_delta", text: "处理新问题", raw: {} }]),
    );
    const current = {
      ...inThreadReply("om_new", "om_root", "再看下这个新问题", true),
      create_time: "3000",
    };
    const deps = makeDeps([current]);
    deps.client.getThreadContext.mockResolvedValue([
      {
        messageId: "om_old_answer",
        senderId: "ou_bot",
        createTime: "2000",
        msgType: "interactive",
        text: "旧问题已处理",
      },
      {
        messageId: "om_new",
        senderId: "ou_user",
        createTime: "3000",
        msgType: "text",
        text: "再看下这个新问题",
      },
    ]);

    await makeHandler(deps).run();
    await waitFor(() => deps.card.finalizeArgs !== undefined);

    expect(deps.cardRenderer.start).toHaveBeenCalledOnce();
    expect(runAgentMock).toHaveBeenCalledOnce();
    expect(deps.card.finalizeArgs).toMatchObject({ success: true, finalText: "处理新问题" });
  });

  it("retries without resume on stale session, then succeeds", async () => {
    await store.put({ threadId: "om_top", sessionId: "ghost", createdTs: 1, lastActiveTs: 1 });
    runAgentMock
      .mockReturnValueOnce(failingRun("No conversation found for session ghost"))
      .mockReturnValueOnce(
        fakeRun([
          { type: "system_init", sessionId: "sess_fresh", raw: {} },
          { type: "text_delta", text: "ok", raw: { message: { id: "m1" } } },
        ]),
      );

    const deps = makeDeps([topEvent("继续")]);
    await makeHandler(deps).run();
    await waitFor(() => deps.card.finalizeArgs !== undefined);

    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({ resumeSessionId: "ghost" });
    expect(runAgentMock.mock.calls[1]?.[0]?.resumeSessionId).toBeUndefined();
    expect(deps.card.finalizeArgs).toMatchObject({ success: true });
    expect(store.get("om_top")?.sessionId).toBe("sess_fresh");
  });

  it("self-heals a corrupt resumed session (tool-call parse error → drop + fresh retry)", async () => {
    await store.put({ threadId: "om_top", sessionId: "corrupt", createdTs: 1, lastActiveTs: 1 });
    runAgentMock
      .mockReturnValueOnce(
        failingRun("claude exited with code 1\nstderr: The model's tool call could not be parsed (retry also failed)"),
      )
      .mockReturnValueOnce(
        fakeRun(
          [
            { type: "system_init", sessionId: "sess_fresh", raw: {} },
            { type: "text_delta", text: "好的", raw: { message: { id: "m1" } } },
          ],
          0,
          "sess_fresh",
        ),
      );

    const deps = makeDeps([topEvent("继续")]);
    await makeHandler(deps).run();
    await waitFor(() => deps.card.finalizeArgs !== undefined);

    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({ resumeSessionId: "corrupt" });
    expect(runAgentMock.mock.calls[1]?.[0]?.resumeSessionId).toBeUndefined(); // fresh
    expect(deps.card.finalizeArgs).toMatchObject({ success: true, finalText: "好的" });
    expect(store.get("om_top")?.sessionId).toBe("sess_fresh");
  });

  it("finalizes failure when claude exits non-zero", async () => {
    runAgentMock.mockReturnValue(failingRun("claude exited with code 1"));
    const deps = makeDeps([topEvent("hi")]);
    await makeHandler(deps).run();
    await waitFor(() => deps.card.finalizeArgs !== undefined);
    expect(deps.card.finalizeArgs).toMatchObject({ success: false });
  });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A run that yields system_init then stays open until aborted (then ends). */
function abortableRun(opts: { abortSignal?: AbortSignal }, sessionId: string): RunHandle {
  const signal = opts.abortSignal;
  async function* gen(): AsyncGenerator<AgentStreamEvent> {
    yield { type: "system_init", sessionId, raw: {} };
    await new Promise<void>((res) => {
      if (signal?.aborted) return res();
      signal?.addEventListener("abort", () => res(), { once: true });
    });
    // aborted → stream ends
  }
  return { events: gen(), done: Promise.resolve({ exitCode: 0, sessionId }), kill: () => {} };
}

/** Two cards (one per message); track each card's finalize args. */
function makeMultiCardDeps(events: LarkMessageEvent[]) {
  const cards: { finalizeArgs: unknown }[] = [];
  const cardRenderer = {
    start: vi.fn(async () => {
      const c = { finalizeArgs: undefined as unknown };
      cards.push(c);
      return {
        messageId: `om_card_${cards.length}`,
        handle: () => {},
        finalize: async (a: unknown) => {
          c.finalizeArgs = a;
        },
      };
    }),
  };
  const client = {
    getBotSenderIds: vi.fn(() => ["cli_bot", "ou_bot"]),
    getThreadContext: vi.fn(async (): Promise<ThreadContextMessage[]> => []),
    async *events(): AsyncIterable<LarkMessageEvent> {
      yield events[0]!;
      await delay(60); // let turn 1 start + reach the await before turn 2 arrives
      yield events[1]!;
    },
  };
  return { cards, cardRenderer, client };
}

// Realistic shape (from live debug): the top-level @ has NO root_id/thread_id;
// the in-thread reply carries thread_id=omt_… and root_id = the top-level msg id.
// Both must resolve to the SAME scheduler key (the root msg id) for interrupt to fire.
function topLevelEvent(messageId: string, text: string): LarkMessageEvent {
  return {
    message_id: messageId,
    chat_id: "oc_1",
    chat_type: "group",
    sender_id: "ou_s",
    mentioned_bot: true,
    content: JSON.stringify({ text }),
    create_time: "1",
  };
}
function inThreadReply(
  messageId: string,
  rootId: string,
  text: string,
  mentionedBot = false,
): LarkMessageEvent {
  return {
    message_id: messageId,
    chat_id: "oc_1",
    chat_type: "group",
    thread_id: "omt_x",
    root_id: rootId,
    sender_id: "ou_s",
    mentioned_bot: mentionedBot,
    content: JSON.stringify({ text }),
    create_time: "2",
  };
}

describe("BridgeHandler interrupt (same-thread)", () => {
  it("a new same-thread message interrupts the in-flight turn and resumes the session", async () => {
    runAgentMock
      .mockImplementationOnce((opts) => abortableRun(opts, "sess_A")) // turn 1: runs until aborted
      .mockImplementationOnce(() =>
        fakeRun(
          [
            { type: "system_init", sessionId: "sess_A", raw: {} },
            { type: "text_delta", text: "合并后的回复", raw: { message: { id: "m2" } } },
          ],
          0,
          "sess_A",
        ),
      );

    const deps = makeMultiCardDeps([
      topLevelEvent("om_root", "原始任务"),
      inThreadReply("om_2", "om_root", "补充:再加上X", true),
    ]);
    const handler = new BridgeHandler({
      client: deps.client as never,
      cardRenderer: deps.cardRenderer as never,
      sessionStore: store,
      workDir,
      agentKind: "claude",
      agentBin: "claude",
      agentSystemPrompt: "测试助手提示词",
      subprocessTimeoutMs: 1000,
    });

    await handler.run();
    // wait until the 2nd card finalized (turn 2 done)
    await waitFor(() => deps.cards.length === 2 && deps.cards[1]!.finalizeArgs !== undefined);

    // turn 1 card → interrupted
    expect(deps.cards[0]!.finalizeArgs).toMatchObject({ interrupted: true });
    // turn 2 card → success with the merged reply
    expect(deps.cards[1]!.finalizeArgs).toMatchObject({ success: true, finalText: "合并后的回复" });
    // turn 2 resumed the SAME session captured by the interrupted turn 1
    expect(runAgentMock.mock.calls[1]?.[0]?.resumeSessionId).toBe("sess_A");
    expect(store.get("om_root")?.sessionId).toBe("sess_A");
  });

  it("ignores an unmentioned reply in a topic that was never activated", async () => {
    runAgentMock.mockReturnValue(
      fakeRun([{ type: "text_delta", text: "should not run", raw: {} }]),
    );
    const deps = makeDeps([inThreadReply("om_2", "om_unknown", "普通回复")]);
    const handler = new BridgeHandler({
      client: deps.client as never,
      cardRenderer: deps.cardRenderer as never,
      sessionStore: store,
      workDir,
      agentKind: "claude",
      agentBin: "claude",
      agentSystemPrompt: "测试助手提示词",
      subprocessTimeoutMs: 1000,
    });

    await handler.run();

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(deps.cardRenderer.start).not.toHaveBeenCalled();
  });

  it("ignores an unmentioned reply even when the topic has a stored session", async () => {
    await store.put({ threadId: "om_root", sessionId: "sess_A", createdTs: 1, lastActiveTs: 1 });
    runAgentMock.mockReturnValue(
      fakeRun([{ type: "text_delta", text: "should not run", raw: {} }]),
    );
    const deps = makeDeps([inThreadReply("om_2", "om_root", "普通讨论")]);
    const handler = new BridgeHandler({
      client: deps.client as never,
      cardRenderer: deps.cardRenderer as never,
      sessionStore: store,
      workDir,
      agentKind: "claude",
      agentBin: "claude",
      agentSystemPrompt: "测试助手提示词",
      subprocessTimeoutMs: 1000,
    });

    await handler.run();

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(deps.cardRenderer.start).not.toHaveBeenCalled();
    expect(store.get("om_root")?.sessionId).toBe("sess_A");
  });

  it("clears a topic session only when the resolution message mentions the bot", async () => {
    await store.put({ threadId: "om_root", sessionId: "sess_A", createdTs: 1, lastActiveTs: 1 });
    runAgentMock.mockReturnValue(
      fakeRun([{ type: "text_delta", text: "should not run", raw: {} }]),
    );
    const deps = makeDeps([inThreadReply("om_2", "om_root", "已解决", true)]);
    const handler = new BridgeHandler({
      client: deps.client as never,
      cardRenderer: deps.cardRenderer as never,
      sessionStore: store,
      workDir,
      agentKind: "claude",
      agentBin: "claude",
      agentSystemPrompt: "测试助手提示词",
      subprocessTimeoutMs: 1000,
    });

    await handler.run();

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(deps.cardRenderer.start).not.toHaveBeenCalled();
    expect(store.get("om_root")).toBeUndefined();
  });
});
