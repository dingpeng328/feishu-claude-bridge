import { describe, expect, it, vi } from "vitest";
import { buildChannelSdkOptions } from "./channel.js";

describe("official Channel SDK connection config", () => {
  it("enables bounded handshakes, REST calls, and app-level keepalive", () => {
    const onUnrecoverable = vi.fn();
    const options = buildChannelSdkOptions(
      {
        appId: "cli_test",
        appSecret: "secret",
        allowedChatIds: new Set(["oc_allowed"]),
      },
      onUnrecoverable,
    );

    expect(options).toMatchObject({
      appId: "cli_test",
      source: "feishu-claude-bridge",
      includeRawEvent: true,
      policy: {
        requireMention: true,
        groupAllowlist: ["oc_allowed"],
      },
      wsConfig: { pingTimeout: 15 },
      handshakeTimeoutMs: 15_000,
      connectTimeoutMs: 15_000,
      httpTimeoutMs: 15_000,
      keepalive: {
        enabled: true,
        intervalMs: 15_000,
        onUnrecoverable,
      },
    });
  });

  it("uses native stream throttling and the SDK's 30k rollover boundary", () => {
    const options = buildChannelSdkOptions({
      appId: "cli_test",
      appSecret: "secret",
      allowedChatIds: new Set(),
    });

    expect(options.outbound).toEqual({
      streamThrottleMs: 100,
      streamThrottleChars: 50,
      streamInitialText: "> ⏳ **正在处理**\n> Agent 正在思考或执行任务...",
      streamMaxElementChars: 30_000,
      retry: { maxAttempts: 3, baseDelayMs: 500 },
    });
  });
});
