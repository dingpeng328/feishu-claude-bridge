import { describe, it, expect, vi } from "vitest";
import {
  ChannelClient,
  channelMsgToLarkEvent,
  apiMessageToLarkEvent,
  resolveStaleMs,
  resolveCooldownMs,
  resolveRefreshMs,
  resolveCatchUpIntervalMs,
  resolveCatchUpLookbackMs,
  shouldRebuildChannel,
  _bridgeCardStatus,
  _historyMessageText,
} from "./channel.js";
import type { LarkMessageEvent } from "./transport.js";

describe("resolveStaleMs", () => {
  it("uses ctor value when given", () => {
    expect(resolveStaleMs(120_000)).toBe(120_000);
  });
  it("0 / negative disables (returns 0)", () => {
    expect(resolveStaleMs(0)).toBe(0);
    expect(resolveStaleMs(-5)).toBe(0);
  });
  it("defaults to 5min when nothing set", () => {
    delete process.env.FCB_CHANNEL_STALE_MS;
    expect(resolveStaleMs()).toBe(300_000);
  });
});

describe("resolveCooldownMs", () => {
  it("uses ctor value when given", () => {
    expect(resolveCooldownMs(120_000)).toBe(120_000);
  });
  it("0 is allowed (disables the cooldown floor)", () => {
    expect(resolveCooldownMs(0)).toBe(0);
  });
  it("negative falls back to the 10min default", () => {
    expect(resolveCooldownMs(-5)).toBe(600_000);
  });
  it("defaults to 10min when nothing set", () => {
    delete process.env.FCB_CHANNEL_REBUILD_COOLDOWN_MS;
    expect(resolveCooldownMs()).toBe(600_000);
  });
});

describe("delivery recovery interval config", () => {
  it("defaults to a 20min proactive refresh", () => {
    delete process.env.FCB_CHANNEL_REFRESH_MS;
    expect(resolveRefreshMs()).toBe(20 * 60_000);
  });
  it("defaults to a 60s history poll and 5min first-start lookback", () => {
    delete process.env.FCB_CATCHUP_INTERVAL_MS;
    delete process.env.FCB_CATCHUP_LOOKBACK_MS;
    expect(resolveCatchUpIntervalMs()).toBe(60_000);
    expect(resolveCatchUpLookbackMs()).toBe(5 * 60_000);
  });
  it("0 disables refresh/polling", () => {
    expect(resolveRefreshMs(0)).toBe(0);
    expect(resolveCatchUpIntervalMs(0)).toBe(0);
  });
});

describe("shouldRebuildChannel", () => {
  // reconnect happened AFTER last inbound, and staleMs has elapsed SINCE the
  // reconnect, and we're well past the cooldown → eligible to rebuild.
  const base = {
    connected: true,
    rebuilding: false,
    closed: false,
    lastInboundAt: 1000,
    lastReconnectAt: 2000,
    lastRebuildAt: -300_000, // last rebuild well beyond the cooldown ago
    connectedAt: 1000,
    now: 2000 + 301_000,
    staleMs: 300_000,
    cooldownMs: 600_000,
    refreshMs: 0,
  };

  it("rebuilds when reconnect-since-inbound + silence > staleMs + past cooldown", () => {
    expect(shouldRebuildChannel(base)).toBe(true);
  });

  it("does NOT rebuild a stable idle connection (no reconnect since last inbound)", () => {
    // Proactive refresh is disabled in this case.
    expect(shouldRebuildChannel({ ...base, lastReconnectAt: 500 })).toBe(false);
  });

  it("proactively rebuilds an apparently healthy connection after refreshMs", () => {
    expect(
      shouldRebuildChannel({
        ...base,
        lastReconnectAt: 500,
        connectedAt: 1_000,
        now: 1_000 + 20 * 60_000,
        refreshMs: 20 * 60_000,
      }),
    ).toBe(true);
  });

  it("does not proactively rebuild before refreshMs", () => {
    expect(
      shouldRebuildChannel({
        ...base,
        lastReconnectAt: 500,
        connectedAt: 1_000,
        now: 1_000 + 60_000,
        refreshMs: 20 * 60_000,
      }),
    ).toBe(false);
  });

  it("measures silence from the RECONNECT, not the last inbound", () => {
    // Idle for ages before reconnect (lastInboundAt far in the past) but the
    // reconnect itself was recent → must NOT rebuild yet (the storm-fix case).
    expect(
      shouldRebuildChannel({
        ...base,
        lastInboundAt: 0,
        lastReconnectAt: base.now - 10_000, // reconnected 10s ago
      }),
    ).toBe(false);
  });

  it("does NOT rebuild before staleMs elapses since the reconnect", () => {
    expect(shouldRebuildChannel({ ...base, now: 2000 + 10_000 })).toBe(false);
  });

  it("honors the cooldown floor (no rebuild too soon after the last one)", () => {
    // Eligible on staleMs grounds, but a rebuild happened 1s ago → blocked.
    expect(shouldRebuildChannel({ ...base, lastRebuildAt: base.now - 1_000 })).toBe(false);
  });

  it("cooldownMs = 0 disables the cooldown floor", () => {
    expect(
      shouldRebuildChannel({ ...base, cooldownMs: 0, lastRebuildAt: base.now - 1_000 }),
    ).toBe(true);
  });

  it("disabled when staleMs = 0", () => {
    expect(shouldRebuildChannel({ ...base, staleMs: 0 })).toBe(false);
  });

  it("no rebuild while already rebuilding / closed / disconnected", () => {
    expect(shouldRebuildChannel({ ...base, rebuilding: true })).toBe(false);
    expect(shouldRebuildChannel({ ...base, closed: true })).toBe(false);
    expect(shouldRebuildChannel({ ...base, connected: false })).toBe(false);
  });
});

describe("channelMsgToLarkEvent", () => {
  it("preserves normalized mention flags for local topic activation", () => {
    const ev = channelMsgToLarkEvent({
      messageId: "om_1",
      chatId: "oc_1",
      chatType: "group",
      senderId: "ou_sender",
      content: "hi",
      mentionedBot: true,
      mentionAll: false,
      createTime: 123,
    });

    expect(ev).toMatchObject({
      message_id: "om_1",
      chat_id: "oc_1",
      mentioned_bot: true,
      mention_all: false,
    });
  });
});

describe("native streaming card history", () => {
  const content = (streamingMode: boolean, markdown: string) =>
    JSON.stringify({
      card_schema: "2.0",
      json_card: JSON.stringify({
        schema: "2.0",
        config: { property: { streaming_mode: streamingMode } },
        body: {
          elements: [
            {
              property: {
                tag: "markdown",
                element_id: "stream_md",
                content: markdown,
              },
            },
          ],
        },
      }),
    });

  it("uses CardKit streaming_mode rather than a visible title", () => {
    expect(_bridgeCardStatus("interactive", content(true, "正在处理..."))).toBe("streaming");
    expect(_bridgeCardStatus("interactive", content(false, "最终答案"))).toBe("success");
    expect(_bridgeCardStatus("interactive", content(false, "> **处理失败**"))).toBe("failure");
    expect(_bridgeCardStatus("interactive", content(false, "> **已被新消息打断**"))).toBe(
      "interrupted",
    );
  });

  it("extracts native card markdown for topic context", () => {
    expect(
      _historyMessageText({
        message_id: "om_card",
        msg_type: "interactive",
        body: { content: content(false, "> ✅ **回复完成**\n\n最终答案") },
      }),
    ).toBe("最终答案");
  });

  it("does not classify an unrelated interactive card as a bridge reply", () => {
    const unrelated = JSON.stringify({
      schema: "2.0",
      config: { streaming_mode: false },
      body: { elements: [{ tag: "markdown", element_id: "other", content: "审批卡片" }] },
    });
    expect(_bridgeCardStatus("interactive", unrelated)).toBeUndefined();
  });
});

describe("apiMessageToLarkEvent", () => {
  const item = {
    message_id: "om_recovered",
    root_id: "om_root",
    thread_id: "omt_1",
    chat_id: "oc_1",
    create_time: "1784879160000",
    sender: { id: "ou_sender", id_type: "open_id", sender_type: "user" },
    body: { content: JSON.stringify({ text: "@bot investigate" }) },
    mentions: [{ key: "@_user_1", id: "ou_bot", id_type: "open_id", name: "bot" }],
  };

  it("converts a direct bot mention recovered from history", () => {
    expect(apiMessageToLarkEvent(item, "ou_bot")).toMatchObject({
      message_id: "om_recovered",
      root_id: "om_root",
      sender_id: "ou_sender",
      mentioned_bot: true,
      recovered_from_history: true,
    });
  });

  it("ignores history messages that do not mention this bot", () => {
    expect(apiMessageToLarkEvent(item, "ou_other_bot")).toBeNull();
  });
});

describe("ChannelClient.getThreadContext", () => {
  it("merges the root, paginates all replies, deduplicates, and keeps the current event", async () => {
    const get = vi.fn(async () => ({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_root",
            thread_id: "omt_real",
            msg_type: "text",
            create_time: "1000",
            sender: { id: "ou_a", sender_name: "Alice" },
            body: { content: JSON.stringify({ text: "根消息" }) },
          },
        ],
      },
    }));
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          has_more: true,
          page_token: "next",
          items: [
            {
              message_id: "om_root",
              msg_type: "text",
              create_time: "1000",
              sender: { id: "ou_a" },
              body: { content: JSON.stringify({ text: "重复根消息" }) },
            },
            {
              message_id: "om_2",
              msg_type: "text",
              create_time: "2000",
              sender: { id: "ou_b" },
              body: { content: JSON.stringify({ text: "中间讨论" }) },
            },
            {
              message_id: "om_answer",
              msg_type: "interactive",
              create_time: "2500",
              sender: { id: "ou_bot" },
              body: {
                content: JSON.stringify({
                  card_schema: "2.0",
                  json_card: JSON.stringify({
                    schema: "2.0",
                    header: {
                      property: { title: { property: { content: "✅ 完成" } } },
                    },
                    body: { elements: [{ tag: "markdown", content: "处理结果" }] },
                  }),
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ code: 0, data: { has_more: false, items: [] } });

    const client = new ChannelClient({
      appId: "app",
      appSecret: "secret",
      allowedChatIds: new Set(),
      deliveryStatePath: "/tmp/fcb-channel-test-delivery.json",
    });
    (client as unknown as { channel: unknown }).channel = {
      rawClient: { im: { v1: { message: { get, list } } } },
    };
    const current: LarkMessageEvent = {
      message_id: "om_3",
      chat_id: "oc_1",
      chat_type: "group",
      thread_id: "omt_real",
      root_id: "om_root",
      sender_id: "ou_c",
      content: JSON.stringify({ text: "@_user_1 请总结" }),
      create_time: "3000",
    };

    const context = await client.getThreadContext("omt_event", "om_root", current);

    expect(context.map((message) => message.messageId)).toEqual([
      "om_root",
      "om_2",
      "om_answer",
      "om_3",
    ]);
    expect(context.map((message) => message.text)).toEqual([
      "根消息",
      "中间讨论",
      "处理结果",
      "请总结",
    ]);
    expect(context.find((message) => message.messageId === "om_answer")?.cardStatus).toBe("success");
    expect(list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        params: expect.objectContaining({
          container_id_type: "thread",
          container_id: "omt_real",
          page_token: undefined,
          card_msg_content_type: "raw_card_content",
        }),
      }),
    );
    expect(list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ params: expect.objectContaining({ page_token: "next" }) }),
    );
  });
});
