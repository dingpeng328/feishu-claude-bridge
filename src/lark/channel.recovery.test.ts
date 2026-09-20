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
    const h = await harness();
    const final = managedCardSpec("> ✅ **回复完成**", "complete answer", false);
    await h.journal.recordCard("user", "entity", "reply");
    await h.journal.saveFinal("user", [{ cardId: "entity", card: final }]);
    h.update.mockRejectedValueOnce(new Error("offline"));
    await h.internal.recoverDeliveries();
    expect((await TurnJournal.load(h.file)).get("user")).toBeDefined();
    await h.internal.recoverDeliveries();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.stored.get("entity")).toEqual(final);
    expect((await TurnJournal.load(h.file)).get("user")).toBeUndefined();
    expect(h.update.mock.calls[1]?.[0]).toBe("entity");
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
