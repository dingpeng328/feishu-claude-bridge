import { describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "../claude/runner.js";
import {
  CardRenderer,
  _formatDuration,
  _liveStatusMarkdown,
  _optimizeMarkdownStyle,
  _terminalMarkdown,
  type MarkdownStreamController,
  type OutboundCardClient,
} from "./card.js";

function makeHarness(now: () => number = () => 0) {
  const statusUpdates: string[] = [];
  const bodyUpdates: string[] = [];
  const replacements: object[] = [];
  let storedMarkdown: string | undefined;
  const controller: MarkdownStreamController = {
    messageId: "om_stream",
    setStatus: vi.fn(async (content: string) => {
      statusUpdates.push(content);
    }),
    setContent: vi.fn(async (content: string) => {
      bodyUpdates.push(content);
    }),
  };
  const outbound: OutboundCardClient = {
    streamMarkdown: vi.fn(async (_chatId, _replyTo, _opts, producer) => {
      await producer(controller);
      return { messageId: controller.messageId };
    }),
    replaceCard: vi.fn(async (_messageId, card) => {
      replacements.push(card);
      const body = card as { body?: { elements?: Array<{ content?: string }> } };
      storedMarkdown = body.body?.elements
        ?.map((element) => element.content?.replace(/\u200b/g, "") ?? "")
        .filter(Boolean)
        .join("\n\n");
    }),
    readCardMarkdown: vi.fn(async () => storedMarkdown),
    releaseCard: vi.fn(),
  };
  return {
    renderer: new CardRenderer({ outbound, now, sleep: async () => undefined }),
    outbound,
    controller,
    statusUpdates,
    bodyUpdates,
    replacements,
  };
}

describe("CardRenderer managed markdown stream", () => {
  it("replaces multi-paragraph snapshots without duplicating earlier paragraphs", async () => {
    const { renderer, bodyUpdates } = makeHarness();
    const card = await renderer.start("chat", "user");
    card.handle({ type: "text_delta", text: "第一段\n\n第二段", raw: { item: { id: "same" } } });
    await new Promise(resolve => setImmediate(resolve));
    card.handle({ type: "text_delta", text: "第一段\n\n第二段继续", raw: { item: { id: "same" } } });
    await card.finalize({ success: true });
    expect(bodyUpdates.at(-1)).toBe("第一段\n\n第二段继续");
  });

  it("refreshes elapsed time during silence and stops the heartbeat at finalization", async () => {
    vi.useFakeTimers();
    try {
      const { renderer, statusUpdates } = makeHarness(() => Date.now());
      const card = await renderer.start("chat", "user");
      card.handle({ type: "raw", raw: { type: "heartbeat" } });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(statusUpdates.at(-1)).toContain("已用时 15 秒");
      expect(statusUpdates.at(-1)).toContain("最近收到 Agent 活动");
      await card.finalize({ success: true, finalText: "done" });
      const count = statusUpdates.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(statusUpdates).toHaveLength(count);
    } finally { vi.useRealTimers(); }
  });
  it("starts a threaded stream with explicit chat and reply ids", async () => {
    const { renderer, outbound, controller } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user", { replyInThread: true });

    expect(card.messageId).toBe("om_stream");
    expect(controller.setStatus).not.toHaveBeenCalled();
    expect(controller.setContent).not.toHaveBeenCalled();
    expect(outbound.streamMarkdown).toHaveBeenCalledWith(
      "oc_chat",
      "om_user",
      {
        replyInThread: true,
        initialStatus: "> ⏳ **正在处理**\n> Agent 正在思考或执行任务...",
      },
      expect.any(Function),
    );
    await card.finalize({ success: true, finalText: "完成" });

    expect(outbound.replaceCard).toHaveBeenCalledWith(
      "om_stream",
      expect.objectContaining({
        schema: "2.0",
        config: expect.objectContaining({ streaming_mode: false }),
        body: {
          elements: [
            expect.objectContaining({ element_id: "status_md" }),
            expect.objectContaining({ element_id: "stream_md", content: "完成" }),
          ],
        },
      }),
    );
    expect(outbound.readCardMarkdown).toHaveBeenCalledWith("om_stream");
    expect(outbound.releaseCard).toHaveBeenCalledWith("om_stream");
  });

  it("replaces partial snapshots and commits clean final markdown", async () => {
    const { renderer, statusUpdates, bodyUpdates } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user");
    const first: AgentStreamEvent = {
      type: "text_delta",
      text: "# 初稿",
      raw: { message: { id: "msg_1" } },
    };
    const second: AgentStreamEvent = {
      type: "text_delta",
      text: "# 最终答案\n\n内容",
      raw: { message: { id: "msg_1" } },
    };
    card.handle(first);
    card.handle(second);

    await card.finalize({ success: true });

    expect(statusUpdates.at(-1)).toBe(
      "> ✅ **回复完成**\n> ⏱️ 处理耗时：不到 1 秒",
    );
    expect(bodyUpdates.at(-1)).toBe("#### 最终答案\n\n内容");
  });

  it("keeps multiple assistant turns separated", async () => {
    const { renderer, bodyUpdates } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user");
    card.handle({ type: "text_delta", text: "第一段", raw: { message: { id: "msg_1" } } });
    card.handle({ type: "text_delta", text: "第二段", raw: { message: { id: "msg_2" } } });

    await card.finalize({ success: true });

    expect(bodyUpdates.at(-1)).toBe("第一段\n\n第二段");
  });

  it("shows elapsed processing time when the stream finishes", async () => {
    let nowMs = 1_000;
    const { renderer, statusUpdates } = makeHarness(() => nowMs);
    const card = await renderer.start("oc_chat", "om_user", { startedAtMs: nowMs });
    nowMs += 65_000;

    await card.finalize({ success: true, finalText: "完成" });

    expect(statusUpdates.at(-1)).toBe(
      "> ✅ **回复完成**\n> ⏱️ 处理耗时：1 分钟 5 秒",
    );
  });

  it("shows live tool counts and never exposes tool input or raw paths", async () => {
    const { renderer, statusUpdates, bodyUpdates } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user");
    card.handle({
      type: "tool_started",
      callId: "tool_1",
      toolName: "Read",
      raw: { input: { file_path: "/private/secret/path" } },
    });
    card.handle({
      type: "text_delta",
      text: "正在生成的正文",
      raw: { message: { id: "msg_1" } },
    });
    card.handle({
      type: "tool_finished",
      callId: "tool_1",
      isError: false,
      raw: { output: "token=secret" },
    });
    await card.finalize({ success: false, failureReason: "token=secret" });

    expect(
      statusUpdates.some((content) =>
        content.includes("已调用 1 次 · 已完成 1 次 · 进行中 0"),
      ),
    ).toBe(true);
    expect(bodyUpdates).toContain("正在生成的正文");
    expect(statusUpdates.at(-1)).toContain("**处理失败**");
    expect(statusUpdates.at(-1)).toContain("共调用 1 次工具");
    expect([...statusUpdates, ...bodyUpdates].join("\n")).not.toContain("/private/secret/path");
    expect([...statusUpdates, ...bodyUpdates].join("\n")).not.toContain("token=secret");
  });

  it("deduplicates lifecycle events and summarizes parallel active tools", async () => {
    const { renderer, statusUpdates } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user");
    const readStarted: AgentStreamEvent = {
      type: "tool_started",
      callId: "tool_1",
      toolName: "Read",
      raw: {},
    };
    card.handle(readStarted);
    card.handle(readStarted);
    card.handle({ type: "tool_started", callId: "tool_2", toolName: "Bash", raw: {} });
    card.handle({ type: "tool_started", callId: "tool_3", toolName: "custom_tool", raw: {} });
    card.handle({ type: "tool_finished", callId: "tool_1", isError: false, raw: {} });
    card.handle({ type: "tool_finished", callId: "tool_1", isError: false, raw: {} });

    await card.finalize({ success: true, finalText: "完成" });

    expect(
      statusUpdates.some(
        (content) =>
          content.includes("已调用 3 次 · 已完成 1 次 · 进行中 2") &&
          content.includes("正在调用：执行命令、custom tool"),
      ),
    ).toBe(true);
    expect(statusUpdates.at(-1)).toContain("共调用 3 次工具");
  });

  it("never rewrites the answer element when tool status changes", async () => {
    const { renderer, statusUpdates, bodyUpdates } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user");

    card.handle({ type: "text_delta", text: "前半", raw: { message: { id: "msg_1" } } });
    await vi.waitFor(() => expect(bodyUpdates).toEqual(["前半"]));

    card.handle({ type: "tool_started", callId: "tool_1", toolName: "Read", raw: {} });
    await vi.waitFor(() => expect(statusUpdates.at(-1)).toContain("正在调用：查找资料"));
    expect(bodyUpdates).toEqual(["前半"]);

    card.handle({ type: "tool_finished", callId: "tool_1", isError: false, raw: {} });
    await vi.waitFor(() => expect(statusUpdates.at(-1)).toContain("正在整理结果"));
    expect(bodyUpdates).toEqual(["前半"]);

    card.handle({
      type: "text_delta",
      text: "前半后半",
      raw: { message: { id: "msg_1" } },
    });
    await vi.waitFor(() => expect(bodyUpdates).toEqual(["前半", "前半后半"]));
    expect(bodyUpdates[1]?.startsWith(bodyUpdates[0] ?? "")).toBe(true);

    await card.finalize({ success: true });
  });

  it("surfaces stream creation failures from start", async () => {
    const outbound: OutboundCardClient = {
      streamMarkdown: vi.fn(async () => {
        throw new Error("card create failed");
      }),
      replaceCard: vi.fn(),
      readCardMarkdown: vi.fn(),
    };
    const renderer = new CardRenderer({ outbound });

    await expect(renderer.start("oc_chat", "om_user")).rejects.toThrow("card create failed");
  });

  it("retries the authoritative final-card replacement after transient failures", async () => {
    const { renderer, outbound } = makeHarness();
    vi.mocked(outbound.replaceCard)
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockRejectedValueOnce(new Error("upstream timeout"));
    const card = await renderer.start("oc_chat", "om_user");

    await card.finalize({ success: true, finalText: "最终答案" });

    expect(outbound.replaceCard).toHaveBeenCalledTimes(3);
  });

  it("does not create a second message when the original card cannot be finalized", async () => {
    const { renderer, outbound } = makeHarness();
    vi.mocked(outbound.replaceCard).mockRejectedValue(new Error("card unavailable"));
    const card = await renderer.start("oc_chat", "om_user", { replyInThread: false });

    await expect(
      card.finalize({ success: true, finalText: "不能丢的最终答案" }),
    ).rejects.toThrow("card finalization failed for original message om_stream");

    expect(outbound.replaceCard).toHaveBeenCalledTimes(3);
  });

  it("refreshes only the original card when readback initially misses the terminal state", async () => {
    const { renderer, outbound } = makeHarness();
    vi.mocked(outbound.readCardMarkdown)
      .mockResolvedValueOnce("> ⏳ **正在处理**")
      .mockResolvedValueOnce("> ⏳ **正在处理**")
      .mockResolvedValueOnce("> ⏳ **正在处理**");
    const card = await renderer.start("oc_chat", "om_user");

    await card.finalize({ success: true, finalText: "最终答案" });

    expect(outbound.replaceCard).toHaveBeenCalledTimes(2);
    expect(outbound.readCardMarkdown).toHaveBeenCalledTimes(4);
  });

  it("finalizes concurrent cards independently without mixing their content", async () => {
    const stored = new Map<string, string>();
    const replaceCard = vi.fn(async (messageId: string, card: object) => {
      const body = card as { body?: { elements?: Array<{ content?: string }> } };
      stored.set(
        messageId,
        body.body?.elements?.map((element) => element.content ?? "").join("\n\n") ?? "",
      );
    });
    const outbound: OutboundCardClient = {
      streamMarkdown: vi.fn(async (_chatId, replyTo, _opts, producer) => {
        const controller: MarkdownStreamController = {
          messageId: `card_${replyTo}`,
          setStatus: vi.fn(async () => undefined),
          setContent: vi.fn(async () => undefined),
        };
        await producer(controller);
        return { messageId: controller.messageId };
      }),
      replaceCard,
      readCardMarkdown: vi.fn(async (messageId) => stored.get(messageId)),
    };
    const renderer = new CardRenderer({ outbound, sleep: async () => undefined });
    const cards = await Promise.all([
      renderer.start("oc_chat", "om_user_1"),
      renderer.start("oc_chat", "om_user_2"),
      renderer.start("oc_chat", "om_user_3"),
    ]);

    await Promise.all(
      cards.map((card, index) => card.finalize({ success: true, finalText: `答案 ${index + 1}` })),
    );

    expect(replaceCard).toHaveBeenCalledTimes(3);
    expect(stored.get("card_om_user_1")).toContain("答案 1");
    expect(stored.get("card_om_user_2")).toContain("答案 2");
    expect(stored.get("card_om_user_3")).toContain("答案 3");
  });
});

describe("markdown presentation", () => {
  it("keeps processing status independent from answer text", () => {
    expect(_liveStatusMarkdown())
      .toBe("> ⏳ **正在处理**\n> Agent 正在思考或执行任务...");
  });

  it("renders compact tool activity in the status element", () => {
    expect(
      _liveStatusMarkdown({
        startedCount: 4,
        completedCount: 1,
        activeNames: ["查找资料", "执行命令", "修改文件"],
      }),
    ).toBe(
      "> ⏳ **正在处理**\n" +
        "> 🔧 已调用 4 次 · 已完成 1 次 · 进行中 3\n" +
        "> 正在调用：查找资料、执行命令，另有 1 个",
    );
  });

  it("demotes chat headings without changing fenced code", () => {
    expect(_optimizeMarkdownStyle("# 标题\n\n```md\n# 保持代码\n```"))
      .toBe("#### 标题\n\n```md\n# 保持代码\n```");
  });

  it("adds a compact interruption state below partial output", () => {
    expect(
      _terminalMarkdown({
        bodyText: "已有内容",
        success: false,
        interrupted: true,
        elapsedMs: 2500,
      }),
    ).toBe(
      "> ⏸️ **已被新消息打断**\n> ⏱️ 处理耗时：3 秒\n> 正在按新消息继续处理。\n\n已有内容",
    );
  });

  it("formats durations across seconds, minutes, and hours", () => {
    expect(_formatDuration(999)).toBe("不到 1 秒");
    expect(_formatDuration(42_400)).toBe("42 秒");
    expect(_formatDuration(65_100)).toBe("1 分钟 5 秒");
    expect(_formatDuration(3_661_000)).toBe("1 小时 1 分钟 1 秒");
  });
});
