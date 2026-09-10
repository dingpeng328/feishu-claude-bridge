import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractWechatText,
  getWechatConversationId,
  getWechatMessageId,
  parseWechatJson,
  WechatItemType,
  WechatProtocolClient,
} from "./protocol.js";

afterEach(() => vi.unstubAllGlobals());

describe("WeChat protocol helpers", () => {
  it("preserves uint64 message IDs", () => {
    const parsed = parseWechatJson<{ message_id: string; nested: { msg_id: string } }>(
      '{"message_id":18446744073709551615,"nested":{"msg_id":9223372036854775807}}',
    );
    expect(parsed.message_id).toBe("18446744073709551615");
    expect(parsed.nested.msg_id).toBe("9223372036854775807");
  });

  it("extracts text and voice transcripts and derives stable IDs", () => {
    const message = {
      message_id: "123",
      from_user_id: "user",
      session_id: "session",
      item_list: [
        { type: WechatItemType.TEXT, text_item: { text: "第一段" } },
        { type: WechatItemType.VOICE, voice_item: { text: "语音转写" } },
      ],
    };
    expect(extractWechatText(message)).toBe("第一段\n语音转写");
    expect(getWechatMessageId(message)).toBe("123");
    expect(getWechatConversationId(message)).toBe("session");
  });

  it("uses authenticated iLink headers and cursor payloads", async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"ret":0,"get_updates_buf":"next"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new WechatProtocolClient({
      baseUrl: "https://example.com",
      token: "secret-token",
      botAgent: "TestBridge/1.0.0",
    });

    await expect(client.getUpdates("cursor-1", 1_000)).resolves.toMatchObject({
      get_updates_buf: "next",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://example.com/ilink/bot/getupdates");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer secret-token",
      AuthorizationType: "ilink_bot_token",
      "iLink-App-Id": "bot",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      get_updates_buf: "cursor-1",
      base_info: { channel_version: "2.4.9", bot_agent: "TestBridge/1.0.0" },
    });
  });
});
