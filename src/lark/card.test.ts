import { describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "../claude/runner.js";
import {
  CardRenderer,
  _formatDuration,
  _liveMarkdown,
  _optimizeMarkdownStyle,
  _terminalMarkdown,
  type MarkdownStreamController,
  type OutboundCardClient,
} from "./card.js";

function makeHarness(now: () => number = () => 0) {
  const updates: string[] = [];
  const replacements: object[] = [];
  let storedMarkdown: string | undefined;
  const controller: MarkdownStreamController = {
    messageId: "om_stream",
    setContent: vi.fn(async (content: string) => {
      updates.push(content);
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
      storedMarkdown = body.body?.elements?.[0]?.content;
    }),
    readCardMarkdown: vi.fn(async () => storedMarkdown),
    releaseCard: vi.fn(),
  };
  return {
    renderer: new CardRenderer({ outbound, now, sleep: async () => undefined }),
    outbound,
    controller,
    updates,
    replacements,
  };
}

describe("CardRenderer native markdown stream", () => {
  it("starts a threaded stream with explicit chat and reply ids", async () => {
    const { renderer, outbound, controller } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user", { replyInThread: true });

    expect(card.messageId).toBe("om_stream");
    expect(controller.setContent).toHaveBeenCalledWith(
      "> ⏳ **正在处理**\n> Agent 正在思考或执行任务...",
    );
    expect(outbound.streamMarkdown).toHaveBeenCalledWith(
      "oc_chat",
      "om_user",
      { replyInThread: true },
      expect.any(Function),
    );
    await card.finalize({ success: true, finalText: "完成" });

    expect(outbound.replaceCard).toHaveBeenCalledWith(
      "om_stream",
      expect.objectContaining({
        schema: "2.0",
        config: expect.objectContaining({ streaming_mode: false }),
      }),
    );
    expect(outbound.readCardMarkdown).toHaveBeenCalledWith("om_stream");
    expect(outbound.releaseCard).toHaveBeenCalledWith("om_stream");
  });

  it("replaces partial snapshots and commits clean final markdown", async () => {
    const { renderer, updates } = makeHarness();
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

    expect(updates.at(-1)).toBe(
      "> ✅ **回复完成**\n> ⏱️ 处理耗时：不到 1 秒\n\n#### 最终答案\n\n内容",
    );
  });

  it("keeps multiple assistant turns separated", async () => {
    const { renderer, updates } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user");
    card.handle({ type: "text_delta", text: "第一段", raw: { message: { id: "msg_1" } } });
    card.handle({ type: "text_delta", text: "第二段", raw: { message: { id: "msg_2" } } });

    await card.finalize({ success: true });

    expect(updates.at(-1)).toBe(
      "> ✅ **回复完成**\n> ⏱️ 处理耗时：不到 1 秒\n\n第一段\n\n第二段",
    );
  });

  it("shows elapsed processing time when the stream finishes", async () => {
    let nowMs = 1_000;
    const { renderer, updates } = makeHarness(() => nowMs);
    const card = await renderer.start("oc_chat", "om_user", { startedAtMs: nowMs });
    nowMs += 65_000;

    await card.finalize({ success: true, finalText: "完成" });

    expect(updates.at(-1)).toBe(
      "> ✅ **回复完成**\n> ⏱️ 处理耗时：1 分钟 5 秒\n\n完成",
    );
  });

  it("shows only generic pre-answer progress and never exposes tool input", async () => {
    const { renderer, updates } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user");
    card.handle({
      type: "tool_use",
      toolName: "Read",
      toolInput: { file_path: "/private/secret/path" },
      raw: {},
    });
    await Promise.resolve();
    await card.finalize({ success: false, failureReason: "token=secret" });

    expect(updates.some((content) => content.includes("正在查找资料..."))).toBe(true);
    expect(updates.at(-1)).toContain("**处理失败**");
    expect(updates.join("\n")).not.toContain("/private/secret/path");
    expect(updates.join("\n")).not.toContain("token=secret");
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
      stored.set(messageId, body.body?.elements?.[0]?.content ?? "");
    });
    const outbound: OutboundCardClient = {
      streamMarkdown: vi.fn(async (_chatId, replyTo, _opts, producer) => {
        const controller: MarkdownStreamController = {
          messageId: `card_${replyTo}`,
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
  it("keeps processing status visible after answer text starts", () => {
    expect(_liveMarkdown("正在生成的正文"))
      .toBe("> ⏳ **正在处理**\n\n正在生成的正文");
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
