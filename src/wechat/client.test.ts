import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _splitText, WechatClient } from "./client.js";
import { loadWechatConfig } from "./config.js";
import { WechatProtocolClient, type GetUpdatesResponse, type WechatMessage } from "./protocol.js";
import { WechatDeliveryState } from "./state.js";

afterEach(() => vi.restoreAllMocks());

describe("WeChat outbound text", () => {
  it("splits by Unicode code points", () => {
    expect(_splitText("甲乙丙丁", 3)).toEqual(["甲乙丙", "丁"]);
    expect(_splitText("😀😀", 1)).toEqual(["😀", "😀"]);
  });
});

function message(id: string, state = 2): WechatMessage {
  return { message_id: id, from_user_id: "user", message_type: 1, message_state: state,
    item_list: [{ type: 1, text_item: { text: state === 2 ? "完整消息" : "部分" } }] };
}

async function clientFixture(responses: GetUpdatesResponse[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wechat-client-"));
  const config = loadWechatConfig({ WECHAT_STATE_DIR: dir });
  const delivery = await WechatDeliveryState.load(config.deliveryPath);
  vi.spyOn(WechatProtocolClient.prototype, "notifyStarted").mockResolvedValue();
  vi.spyOn(WechatProtocolClient.prototype, "notifyStopped").mockResolvedValue();
  const poll = vi.spyOn(WechatProtocolClient.prototype, "getUpdates").mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected additional poll");
    return response;
  });
  const client = new WechatClient({ config, delivery, credentials: {
    accountId: "bot", userId: "user", token: "test", baseUrl: "https://example.com", connectedAt: 1,
  } });
  return { client, delivery, config, poll };
}

describe("WeChat durable delivery", () => {
  it("accepts the finished update after partial updates with the same message ID", async () => {
    const { client, delivery, poll } = await clientFixture([
      { msgs: [message("1", 0), message("1", 1)], get_updates_buf: "partial" },
      { msgs: [message("1")], get_updates_buf: "finished" },
    ]);
    const events = client.events();
    const event = (await events.next()).value!;
    expect(event.text).toBe("完整消息");
    expect(poll).toHaveBeenCalledTimes(2);
    expect(delivery.has("1")).toBe(false);
    event.ack();
    await client.close();
    await events.next();
    await client.flush();
    expect(delivery.has("1")).toBe(true);
    expect(delivery.cursor).toBe("finished");
  });

  it("does not advance the cursor past unseen messages when closed in the middle of a batch", async () => {
    const { client, config } = await clientFixture([
      { msgs: [message("1"), message("2")], get_updates_buf: "batch-end" },
    ]);
    const events = client.events();
    const event = (await events.next()).value!;
    event.ack();
    await client.close();
    await events.next();
    await client.flush();
    const restored = await WechatDeliveryState.load(config.deliveryPath);
    expect(restored.has("1")).toBe(true);
    expect(restored.has("2")).toBe(false);
    expect(restored.cursor).toBe("");
  });

  it("keeps a retryable message and its cursor for replay without hanging flush", async () => {
    const { client, config } = await clientFixture([
      { msgs: [message("1")], get_updates_buf: "batch-end" },
    ]);
    const events = client.events();
    const event = (await events.next()).value!;
    event.retry();
    event.ack(); // Settlement is idempotent: retry cannot be overwritten by ack.
    await events.next();
    await client.close();
    await client.flush();
    const restored = await WechatDeliveryState.load(config.deliveryPath);
    expect(restored.has("1")).toBe(false);
    expect(restored.cursor).toBe("");
  });

  it("persists already acknowledged messages when the consumer exits a batch early", async () => {
    const { client, config } = await clientFixture([
      { msgs: [message("1"), message("2"), message("3")], get_updates_buf: "batch-end" },
    ]);
    const events = client.events();
    const first = (await events.next()).value!;
    first.ack();
    const second = (await events.next()).value!;
    second.retry();
    await events.return(undefined);
    await client.close();
    await client.flush();
    const restored = await WechatDeliveryState.load(config.deliveryPath);
    expect(restored.has("1")).toBe(true);
    expect(restored.has("2")).toBe(false);
    expect(restored.has("3")).toBe(false);
    expect(restored.cursor).toBe("");
  });

  it("deduplicates in-flight messages while polling beyond an unacknowledged batch", async () => {
    const { client, delivery } = await clientFixture([
      { msgs: [message("1")], get_updates_buf: "first" },
      { msgs: [message("1"), message("2")], get_updates_buf: "second" },
    ]);
    const events = client.events();
    const first = (await events.next()).value!;
    const second = (await events.next()).value!;
    expect(second.messageId).toBe("2");
    second.ack();
    expect(delivery.cursor).toBe("");
    first.ack();
    await client.close();
    await events.next();
    await client.flush();
    expect(delivery.cursor).toBe("second");
    expect(delivery.has("1")).toBe(true);
    expect(delivery.has("2")).toBe(true);
  });
});
