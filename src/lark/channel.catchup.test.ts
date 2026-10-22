import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelClient } from "./channel.js";
import type { LarkMessageEvent } from "./transport.js";

afterEach(() => vi.useRealTimers());

function harness(list: ReturnType<typeof vi.fn>) {
  const client = new ChannelClient({
    appId: "fake", appSecret: "fake", allowedChatIds: new Set(["chat"]),
    deliveryStatePath: "/unused/catchup-test.json",
  });
  const state = {
    cursorMs: Date.now() - 120_000,
    hasSeen: vi.fn(() => false),
    rememberChat: vi.fn(),
    advanceCursor: vi.fn(),
  };
  const acceptEvent = vi.fn(async (_event: LarkMessageEvent) => undefined);
  const internal = client as unknown as {
    channel: unknown;
    deliveryState: unknown;
    acceptEvent: typeof acceptEvent;
    catchUpOnce(reason: "poll"): Promise<void>;
  };
  internal.channel = {
    botIdentity: { openId: "bot" },
    rawClient: { im: { v1: { message: { list } } } },
  };
  internal.deliveryState = state;
  internal.acceptEvent = acceptEvent;
  return { internal, state, acceptEvent };
}

describe("history catch-up pagination", () => {
  it("recovers mentions after page 20 before advancing the cursor", async () => {
    let pages = 0;
    const list = vi.fn(async () => {
      const page = ++pages;
      return { code: 0, data: {
        has_more: page < 21,
        page_token: page < 21 ? `page-${page + 1}` : undefined,
        items: page < 21 ? [] : [{
          message_id: "late-mention", chat_id: "chat", create_time: String(Date.now() - 1000),
          sender: { id: "user", id_type: "open_id", sender_type: "user" },
          mentions: [{ id: "bot", id_type: "open_id" }],
          body: { content: JSON.stringify({ text: "please respond" }) },
        }],
      } };
    });
    const h = harness(list);
    await h.internal.catchUpOnce("poll");
    expect(list).toHaveBeenCalledTimes(21);
    expect(h.acceptEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message_id: "late-mention" }));
    expect(h.state.advanceCursor).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["repeated", "same-page"],
    ["missing", undefined],
  ])("retains the cursor when a continuation token is %s", async (_label, token) => {
    const list = vi.fn(async () => ({ code: 0, data: { items: [], has_more: true, page_token: token } }));
    const h = harness(list);
    await h.internal.catchUpOnce("poll");
    expect(list.mock.calls.length).toBeLessThanOrEqual(2);
    expect(h.state.advanceCursor).not.toHaveBeenCalled();
    expect(h.acceptEvent).not.toHaveBeenCalled();
  });

  it("bounds a stuck history request and leaves the cursor available for retry", async () => {
    vi.useFakeTimers();
    const list = vi.fn(() => new Promise<never>(() => undefined));
    const h = harness(list);
    let settled = false;
    const pending = h.internal.catchUpOnce("poll").then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(true);
    await pending;
    expect(h.state.advanceCursor).not.toHaveBeenCalled();
  });
});
