import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardRenderer } from "./card.js";
import { ChannelClient } from "./channel.js";
import { TurnJournal } from "./turnJournal.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
type Card = { config: { streaming_mode: boolean }; body: { elements: Array<{ element_id: string; content: string }> } };

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "fcb-card-delivery-")); dirs.push(dir);
  const file = join(dir, "pending.json");
  const journal = await TurnJournal.load(file);
  const cards = new Map<string, Card>();
  const messages = new Map<string, string>();
  let count = 0;
  const faults = { failTail: false };
  const client = new ChannelClient({ appId: "fake", appSecret: "fake", allowedChatIds: new Set(), deliveryStatePath: join(dir, "delivery.json") });
  const internal = client as unknown as { channel: unknown; journal: TurnJournal; recoveryIds: Set<string>; recoverDeliveries(): Promise<void> };
  internal.journal = journal;
  internal.channel = {
    createCard: async (card: Card) => { const cardId = `c${++count}`; cards.set(cardId, structuredClone(card)); return { cardId }; },
    send: async (_chat: string, input: { cardId: string }) => { const messageId = `m${messages.size + 1}`; messages.set(messageId, input.cardId); return { messageId }; },
    updateCardById: async (id: string, card: Card) => {
      if (faults.failTail && id === "c2" && card.body.elements[0]?.content.includes("回复完成")) throw new Error("tail delivery unavailable");
      cards.set(id, structuredClone(card));
    },
    rawClient: {
      cardkit: { v1: { cardElement: { content: async ({ path, data }: { path: { card_id: string; element_id: string }; data: { content: string } }) => {
        cards.get(path.card_id)!.body.elements.find(e => e.element_id === path.element_id)!.content = data.content;
        return { code: 0 };
      } } } },
      im: { v1: { message: { get: async ({ path }: { path: { message_id: string } }) => ({ code: 0, data: { items: [{
        message_id: path.message_id, msg_type: "interactive", body: { content: JSON.stringify(cards.get(messages.get(path.message_id)!)) },
      }] } }) } } },
    },
  };
  const renderer = new CardRenderer({ outbound: client.outboundCardClient(), sleep: async () => undefined });
  return { renderer, internal, journal, file, cards, messages, faults };
}

describe("renderer, CardKit adapter and delivery journal together", () => {
  it("delivers all 30001 characters after a partial paragraph crosses the rollover boundary", async () => {
    const h = await harness();
    const card = await h.renderer.start("chat", "user");
    const prefix = "a".repeat(28_000);
    card.handle({ type: "text_delta", text: `${prefix}\n${"b".repeat(500)}`, raw: { item: { id: "same" } } });
    await new Promise(resolve => setTimeout(resolve, 20));
    const final = `${prefix}\n${"b".repeat(2000)}`;
    card.handle({ type: "text_delta", text: final, raw: { item: { id: "same" } } });
    await card.finalize({ success: true, finalText: final });
    expect([...h.cards.values()].map(c => c.body.elements[1]!.content).join("\n")).toBe(final);
    expect(h.messages.size).toBe(2);
    expect(h.journal.list()).toEqual([]);
    expect([...h.cards.values()].every(c => !c.config.streaming_mode)).toBe(true);
  });

  it("retains a failed final tail and recovers both original cards after reloading the journal", async () => {
    const h = await harness();
    const card = await h.renderer.start("chat", "user");
    const final = `${"a".repeat(28_000)}\n${"b".repeat(2000)}`;
    h.faults.failTail = true;
    await expect(card.finalize({ success: true, finalText: final })).rejects.toThrow("delivery pending");
    const reloaded = await TurnJournal.load(h.file);
    expect(reloaded.get("user")?.finalContent?.body).toBe(final);
    h.internal.journal = reloaded;
    h.internal.recoveryIds.add("user");
    h.faults.failTail = false;
    await h.internal.recoverDeliveries();
    expect([...h.cards.values()].map(c => c.body.elements[1]!.content).join("\n")).toBe(final);
    expect(h.messages.size).toBe(2);
    expect((await TurnJournal.load(h.file)).list()).toEqual([]);
  });
});
