import { describe, it, expect } from "vitest";
import {
  channelMsgToLarkEvent,
  apiMessageToLarkEvent,
  resolveStaleMs,
  resolveCooldownMs,
  resolveRefreshMs,
  resolveCatchUpIntervalMs,
  resolveCatchUpLookbackMs,
  shouldRebuildChannel,
} from "./channel.js";

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
