import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChannelClient, finalCardMatches } from "./channel.js";
import { TurnJournal } from "./turnJournal.js";
import { managedCardSpec } from "./cardStream.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "fcb-recovery-test-")); dirs.push(dir);
  const file = join(dir, "pending.json");
  const journal = await TurnJournal.load(file);
  await journal.begin({ messageId: "user", chatId: "chat", replyInThread: true, startedAtMs: 1 });
  const stored = new Map<string, object>();
  const send = vi.fn(async () => ({ messageId: "reply" }));
  const update = vi.fn(async (id: string, card: object) => { stored.set(id, card); });
  const client = new ChannelClient({ appId: "fake", appSecret: "fake", allowedChatIds: new Set(), deliveryStatePath: join(dir, "delivery.json") });
  const internal = client as unknown as {
    journal: TurnJournal; channel: unknown; recoveryIds: Set<string>;
    recoverDeliveries(): Promise<void>;
    rebuildChannel(): Promise<void>;
    connectChannel(): Promise<void>;
    connected: boolean;
  };
  internal.journal = journal;
  internal.recoveryIds.add("user");
  internal.channel = {
    disconnect: async () => undefined,
    send, createCard: async () => ({ cardId: "entity" }), updateCardById: update,
    rawClient: { im: { v1: { message: { get: async () => ({ code: 0, data: { items: [{
      message_id: "reply", msg_type: "interactive", body: { content: JSON.stringify(stored.get("entity")) },
    }] } }) } } } },
  };
  return { client, internal, journal, file, send, update, stored };
}

describe("delivery recovery and connection retry", () => {
  it("retries the original persisted final card after a failed delivery without sending another reply", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = await harness();
    const final = managedCardSpec("> ✅ **回复完成**", "complete answer", false);
    await h.journal.recordCard("user", "entity", "reply");
    await h.journal.saveFinal("user", [{ cardId: "entity", card: final }]);
    h.update.mockRejectedValueOnce(new Error("offline"));
    await h.internal.recoverDeliveries();
    expect((await TurnJournal.load(h.file)).get("user")).toBeDefined();
    await h.internal.recoverDeliveries();
    expect(h.update).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 15_000);
    await h.internal.recoverDeliveries();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.stored.get("entity")).toEqual(final);
    expect((await TurnJournal.load(h.file)).get("user")).toBeUndefined();
    expect(h.update.mock.calls[1]?.[0]).toBe("entity");
  });

  it("backs off repeated delivery failures up to five minutes and retains the journal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = await harness();
    await h.journal.recordCard("user", "entity", "reply");
    await h.journal.saveFinalContent("user", "回复完成", "完整正文");
    h.update.mockRejectedValue(new Error("offline"));
    await h.internal.recoverDeliveries();
    let attempts = 1;
    for (const delay of [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      vi.setSystemTime(Date.now() + delay - 1);
      await h.internal.recoverDeliveries();
      expect(h.update).toHaveBeenCalledTimes(attempts);
      vi.setSystemTime(Date.now() + 1);
      await h.internal.recoverDeliveries();
      expect(h.update).toHaveBeenCalledTimes(++attempts);
    }
    expect((await TurnJournal.load(h.file)).get("user")?.finalContent?.body).toBe("完整正文");
    expect(h.send).not.toHaveBeenCalled();
    h.update.mockImplementation(async (id, card) => { h.stored.set(id, card); });
    vi.setSystemTime(Date.now() + 300_000);
    await h.internal.recoverDeliveries();
    expect(h.journal.get("user")).toBeUndefined();
  });

  it("recovers saved nested blocks using compatible Markdown without changing the saved answer", async () => {
    const h = await harness();
    const body = "1. Rule\n\n   ```text\n   if ready:\n       grant()\n   ```\n\n   | Name | Value |\n   |---|---|\n   | quota | 20000 |";
    await h.journal.recordCard("user", "entity", "reply");
    await h.journal.saveFinalContent("user", "回复完成", body);
    h.internal.journal = await TurnJournal.load(h.file);
    await h.internal.recoverDeliveries();
    const delivered = h.stored.get("entity") as { body: { elements: Array<{ content: string }> } };
    expect(delivered.body.elements[1]?.content).toContain("\n```text\nif ready:\n    grant()\n```\n");
    expect(delivered.body.elements[1]?.content).toContain("\n| Name | Value |\n|---|---|\n| quota | 20000 |");
    expect(h.journal.get("user")?.finalContent?.body).toBe(body);
    expect((await TurnJournal.load(h.file)).get("user")).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("marks interrupted work on its existing card and retains ambiguous sends without duplication", async () => {
    const h = await harness();
    await h.journal.recordCard("user", "entity"); // crash after send, before message id was saved
    await h.journal.markSending("user", "entity");
    await h.internal.recoverDeliveries();
    expect(h.send).not.toHaveBeenCalled();
    expect(JSON.stringify(h.stored.get("entity"))).toContain("处理已中断");
    expect(h.journal.get("user")).toBeDefined();
  });

  it("sends a recorded but never attempted card exactly once after restart", async () => {
    const h = await harness();
    await h.journal.recordCard("user", "entity");
    await h.internal.recoverDeliveries();
    await h.internal.recoverDeliveries();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send).toHaveBeenCalledWith("chat", { cardId: "entity" }, { replyTo: "user", replyInThread: true });
    expect(h.journal.get("user")).toBeUndefined();
  });

  it.each(["live", "recovery"])("persists a late %s send acknowledgement after the local timeout without resending", async mode => {
    vi.useFakeTimers();
    const h = await harness();
    let acknowledge!: (result: { messageId: string }) => void;
    h.send.mockImplementation(() => new Promise(resolve => { acknowledge = resolve; }));
    const producer = vi.fn(async () => undefined);
    if (mode === "recovery") await h.journal.recordCard("user", "entity");
    const pending = (mode === "live"
      ? h.client.outboundCardClient().streamMarkdown("chat", "user", { replyInThread: true, initialStatus: "处理中" }, producer)
      : h.internal.recoverDeliveries()).catch(error => error as Error);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    if (mode === "live") expect(result).toBeInstanceOf(Error);
    expect(producer).not.toHaveBeenCalled();
    expect(h.journal.get("user")?.cards[0]?.messageId).toBeUndefined();

    acknowledge({ messageId: "reply" });
    await vi.waitFor(() => expect(h.journal.get("user")?.cards[0]?.messageId).toBe("reply"));
    await h.journal.close();
    expect((await TurnJournal.load(h.file)).get("user")?.cards[0]?.messageId).toBe("reply");
    await vi.advanceTimersByTimeAsync(15_000);
    await h.internal.recoverDeliveries();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.journal.get("user")).toBeUndefined();
  });

  it("handles a late send rejection and retains the ambiguous original card", async () => {
    vi.useFakeTimers();
    const h = await harness();
    let failSend!: (reason: Error) => void;
    h.send.mockImplementation(() => new Promise((_resolve, reject) => { failSend = reject; }));
    const pending = h.client.outboundCardClient().streamMarkdown(
      "chat", "user", { replyInThread: true, initialStatus: "处理中" }, async () => undefined,
    ).catch(error => error as Error);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toBeInstanceOf(Error);
    failSend(new Error("connection reset after timeout"));
    await vi.advanceTimersByTimeAsync(0);
    await h.internal.recoverDeliveries();
    expect(h.journal.get("user")?.cards[0]?.messageId).toBeUndefined();
    expect(h.journal.get("user")?.cards[0]?.sendStartedAtMs).toBeDefined();
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("recovers the authoritative answer saved before final card allocation", async () => {
    const h = await harness();
    await h.journal.recordCard("user", "entity", "reply");
    await h.journal.saveFinalContent("user", "> ✅ **回复完成**", "保存的最终正文");
    h.internal.journal = await TurnJournal.load(h.file);
    await h.internal.recoverDeliveries();
    expect(JSON.stringify(h.stored.get("entity"))).toContain("保存的最终正文");
    expect(h.send).not.toHaveBeenCalled();
  });

  it("schedules a new connection attempt after a failed rebuild", async () => {
    vi.useFakeTimers();
    const h = await harness();
    h.internal.connected = true;
    const connect = vi.fn().mockRejectedValueOnce(new Error("temporary outage")).mockImplementationOnce(async () => { h.internal.connected = true; });
    h.internal.connectChannel = connect;
    await h.internal.rebuildChannel();
    expect(h.client.isConnected()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(h.client.isConnected()).toBe(true);
    await h.client.close();
  });

  it("rejects success markers with a truncated or missing answer body", () => {
    const expected = managedCardSpec("> ✅ **回复完成**", "完整正文尾部", false);
    expect(finalCardMatches(JSON.stringify(managedCardSpec("> ✅ **回复完成**", "完整正文", false)), expected)).toBe(false);
    expect(finalCardMatches(JSON.stringify(expected), expected)).toBe(true);
    expect(finalCardMatches(JSON.stringify(managedCardSpec("回复完成", "a*b", false)), managedCardSpec("回复完成", "ab", false))).toBe(false);
    expect(finalCardMatches(JSON.stringify(managedCardSpec("> ✅ **回复完成**", "完整正文尾部", true)), expected)).toBe(false);
  });

  it("reads CardKit code-block token lines and still rejects missing or altered code", () => {
    const expected = managedCardSpec("✅ 回复完成", "规则：\n```python\nif ready:\n    grant(20000)\n```\n结束。", false);
    const block = { tag: "code_block", property: { contents: [
      { contents: [{ content: "if ready:", contentType: "text" }, { content: "\n", contentType: "text" }] },
      { contents: [{ contentType: "text" }, { content: "    grant(20000)", contentType: "text" }, { content: "\n", contentType: "text" }] },
    ] } };
    const compiled = (includeCode: boolean) => JSON.stringify({ json_card: JSON.stringify({
      config: { streamingMode: false },
      body: { property: { elements: [
        { tag: "markdown", property: { elements: [{ tag: "plain_text", property: { content: "✅ 回复完成" } }] } },
        { tag: "markdown", property: { elements: [
          { tag: "plain_text", property: { content: "规则：" } },
          ...(includeCode ? [block] : []),
          { tag: "plain_text", property: { content: "结束。" } },
        ] } },
      ] } },
    }) });
    expect(finalCardMatches(compiled(true), expected)).toBe(true);
    expect(finalCardMatches(compiled(false), expected)).toBe(false);
    expect(finalCardMatches(compiled(true).replace("20000", "2000"), expected)).toBe(false);
  });

  it("accepts a final card whose Markdown table is compiled by CardKit", () => {
    const expected = managedCardSpec(
      "> ✅ **回复完成**",
      "| 公司 | 8月件量 |\n|---|---:|\n| 圆通 | **28.36亿** |",
      false,
    );
    const compiled = JSON.stringify({
      json_card: JSON.stringify({
        schema: "2.0",
        config: { streamingMode: false },
        body: {
          property: {
            elements: [
              {
                id: "status_md",
                tag: "markdown",
                property: {
                  elements: [{ tag: "plain_text", property: { content: "✅ 回复完成" } }],
                },
              },
              {
                id: "stream_md",
                tag: "markdown",
                property: {
                  elements: [{
                    tag: "table",
                    property: {
                      columns: [
                        { name: "0", displayName: "公司" },
                        { name: "1", displayName: "8月件量" },
                      ],
                      rows: [{
                        0: { data: { tag: "markdown", property: { elements: [{ tag: "plain_text", property: { content: "圆通" } }] } } },
                        1: { data: { tag: "markdown", property: { elements: [{ tag: "plain_text", property: { content: "28.36亿" } }] } } },
                      }],
                    },
                  }],
                },
              },
            ],
          },
        },
      }),
    });

    expect(finalCardMatches(compiled, expected)).toBe(true);
  });
});
