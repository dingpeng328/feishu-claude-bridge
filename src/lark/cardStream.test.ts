import { describe, expect, it, vi } from "vitest";
import {
  BODY_ELEMENT_ID,
  ManagedMarkdownStream,
  STATUS_ELEMENT_ID,
  splitManagedMarkdown,
  type ManagedCardTransport,
} from "./cardStream.js";

function makeTransport() {
  let cardSequence = 0;
  let messageSequence = 0;
  const transport: ManagedCardTransport = {
    createCard: vi.fn(async () => ({ cardId: `card_${++cardSequence}` })),
    sendCard: vi.fn(async () => ({ messageId: `message_${++messageSequence}` })),
    updateElement: vi.fn(async () => undefined),
    updateCard: vi.fn(async () => undefined),
  };
  return transport;
}

function cardConfig(card: object): { streaming_mode?: boolean } | undefined {
  return (card as { config?: { streaming_mode?: boolean } }).config;
}

function cardBodyContents(card: object): string[] {
  return (
    card as { body?: { elements?: Array<{ content?: string }> } }
  ).body?.elements?.map((element) => element.content ?? "") ?? [];
}

describe("ManagedMarkdownStream", () => {
  it("retains final text and stops creating replies after a send acknowledgement is lost", async () => {
    const transport = makeTransport();
    transport.saveFinalContent = vi.fn(async () => undefined);
    const stream = await ManagedMarkdownStream.start({ transport, chatId: "chat", replyToMessageId: "user", replyInThread: true, initialStatus: "处理中" });
    vi.mocked(transport.sendCard).mockRejectedValueOnce(new Error("reply acknowledgement lost"));
    await expect(stream.setContent("x".repeat(31_000))).rejects.toThrow("acknowledgement lost");
    await stream.setContent("x".repeat(32_000));
    stream.setFinalContent("回复完成", "最终正文");
    await expect(stream.complete()).rejects.toThrow("acknowledgement missing");
    expect(transport.sendCard).toHaveBeenCalledTimes(2);
    expect(transport.saveFinalContent).toHaveBeenCalledWith("回复完成", "最终正文");
  });
  it("keeps a growing paragraph complete when it crosses the live card boundary", async () => {
    const transport = makeTransport();
    const stream = await ManagedMarkdownStream.start({ transport, chatId: "chat", replyToMessageId: "user", replyInThread: true, initialStatus: "处理中" });
    const head = "a".repeat(28_000);
    await stream.setContent(`${head}\n${"b".repeat(500)}`);
    const final = `${head}\n${"b".repeat(2000)}`;
    await stream.setContent(final);
    stream.setFinalContent("回复完成", final);
    await stream.complete();
    const finalCards = vi.mocked(transport.updateCard).mock.calls.slice(-2).map(([, card]) => cardBodyContents(card)[1]);
    expect(finalCards.join("\n")).toBe(final);
    expect(transport.sendCard).toHaveBeenCalledTimes(2);
  });

  it("commits revised final text on all original segments and clears leftover draft tails", async () => {
    const transport = makeTransport();
    const stream = await ManagedMarkdownStream.start({ transport, chatId: "chat", replyToMessageId: "user", replyInThread: true, initialStatus: "处理中" });
    await stream.setContent("draft".repeat(7000));
    stream.setFinalContent("回复完成", "最终短答案");
    await stream.complete();
    const bodies = vi.mocked(transport.updateCard).mock.calls.slice(-2).map(([, card]) => cardBodyContents(card)[1]);
    expect(bodies).toEqual(["最终短答案", "正文已更新至前方卡片。"]);
    expect(transport.sendCard).toHaveBeenCalledTimes(2);
  });

  it("does not declare success when a continuation body cannot be confirmed", async () => {
    const transport = makeTransport();
    transport.verifyCard = vi.fn(async messageId => messageId === "message_1");
    transport.saveFinal = vi.fn(async () => undefined);
    const stream = await ManagedMarkdownStream.start({ transport, chatId: "chat", replyToMessageId: "user", replyInThread: true, initialStatus: "处理中" });
    stream.setFinalContent("回复完成", "x".repeat(31_000));
    await expect(stream.complete()).rejects.toThrow("delivery pending");
    expect(transport.saveFinal).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ cardId: "card_2" }),
    ]));
  });
  it("isolates mutable status from monotonic answer updates", async () => {
    const transport = makeTransport();
    const stream = await ManagedMarkdownStream.start({
      transport,
      chatId: "oc_chat",
      replyToMessageId: "om_user",
      replyInThread: true,
      initialStatus: "处理中",
    });

    await stream.setContent("前半");
    await stream.setStatus("正在调用工具");
    await stream.setContent("前半后半");

    expect(transport.updateElement).toHaveBeenNthCalledWith(
      1,
      "card_1",
      BODY_ELEMENT_ID,
      "\u200b前半",
      1,
    );
    expect(transport.updateElement).toHaveBeenNthCalledWith(
      2,
      "card_1",
      STATUS_ELEMENT_ID,
      "正在调用工具",
      2,
    );
    expect(transport.updateElement).toHaveBeenNthCalledWith(
      3,
      "card_1",
      BODY_ELEMENT_ID,
      "\u200b前半后半",
      3,
    );

    const bodyUpdates = vi.mocked(transport.updateElement).mock.calls
      .filter(([, elementId]) => elementId === BODY_ELEMENT_ID)
      .map(([, , content]) => content);
    expect(bodyUpdates[1]?.startsWith(bodyUpdates[0] ?? "")).toBe(true);

    // A model-side revision is not sent through the typewriter API because it
    // would replay existing text; the final static-card replacement owns it.
    await stream.setContent("改写后的答案");
    expect(transport.updateElement).toHaveBeenCalledTimes(3);

    await stream.complete();
    expect(transport.updateCard).toHaveBeenCalledWith(
      "card_1",
      expect.objectContaining({ config: expect.objectContaining({ streaming_mode: false }) }),
      4,
    );
  });

  it("retains the latest status for whole-card recovery after a live update fails", async () => {
    const transport = makeTransport();
    vi.mocked(transport.updateElement).mockRejectedValueOnce(new Error("transient failure"));
    const stream = await ManagedMarkdownStream.start({
      transport,
      chatId: "oc_chat",
      replyToMessageId: "om_user",
      replyInThread: true,
      initialStatus: "处理中",
    });

    await expect(stream.setStatus("回复完成")).rejects.toThrow("transient failure");
    await stream.complete();

    const recoveredCard = vi.mocked(transport.updateCard).mock.calls[0]?.[1];
    expect(cardBodyContents(recoveredCard ?? {})).toEqual(["回复完成", "\u200b"]);
  });

  it("rolls long answers into continuation cards with independent sequences", async () => {
    const transport = makeTransport();
    const stream = await ManagedMarkdownStream.start({
      transport,
      chatId: "oc_chat",
      replyToMessageId: "om_user",
      replyInThread: false,
      initialStatus: "处理中",
    });
    const head = "a".repeat(28_900);
    const full = `${head}\n${"b".repeat(1_000)}`;

    await stream.setContent(head);
    await stream.setContent(full);
    await stream.setStatus("正在整理结果");
    await stream.complete();

    expect(transport.createCard).toHaveBeenCalledTimes(2);
    expect(transport.sendCard).toHaveBeenNthCalledWith(
      2,
      "oc_chat",
      "card_2",
      "om_user",
      false,
    );
    expect(transport.updateElement).toHaveBeenLastCalledWith(
      "card_2",
      STATUS_ELEMENT_ID,
      "正在整理结果",
      1,
    );

    const cardUpdates = vi.mocked(transport.updateCard).mock.calls;
    expect(cardUpdates.map(([cardId, , sequence]) => [cardId, sequence])).toEqual([
      ["card_1", 2],
      ["card_1", 3],
      ["card_2", 2],
    ]);
    for (const [, card] of cardUpdates.slice(-2)) {
      expect(cardConfig(card)?.streaming_mode).toBe(false);
      expect(Math.max(...cardBodyContents(card).map((content) => content.length))).toBeLessThan(
        30_000,
      );
    }

    await stream.replaceHead({ schema: "2.0", config: { streaming_mode: false } });
    expect(transport.updateCard).toHaveBeenLastCalledWith(
      "card_1",
      { schema: "2.0", config: { streaming_mode: false } },
      4,
    );
  });
});

describe("splitManagedMarkdown", () => {
  it("keeps fenced chunks valid and hard-splits an oversized line", () => {
    const fenced = splitManagedMarkdown(`\`\`\`ts\n${"const x = 1;\n".repeat(12)}\`\`\``, 80);
    expect(fenced.length).toBeGreaterThan(1);
    expect(fenced[0]).toMatch(/\n```$/);
    expect(fenced[1]).toMatch(/^```ts/);
    expect(fenced.every((chunk) => chunk.length < 100)).toBe(true);

    const longLine = splitManagedMarkdown("x".repeat(205), 80);
    expect(longLine.map((chunk) => chunk.length)).toEqual([80, 80, 45]);
  });
});
