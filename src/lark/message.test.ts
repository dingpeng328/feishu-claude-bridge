import { describe, it, expect } from "vitest";
import { parseMessage, sessionKeyOf } from "./message.js";
import type { LarkMessageEvent } from "./transport.js";

function ev(partial: Partial<LarkMessageEvent>): LarkMessageEvent {
  return {
    message_id: "om_1",
    chat_id: "oc_1",
    chat_type: "group",
    sender_id: "ou_sender",
    content: JSON.stringify({ text: "hello" }),
    create_time: "1000",
    ...partial,
  };
}

describe("parseMessage", () => {
  it("extracts text from a text message and strips @ placeholders", () => {
    const p = parseMessage(ev({ content: JSON.stringify({ text: "@_user_1 你好 bot" }) }));
    expect(p.text).toBe("你好 bot");
    expect(p.senderOpenId).toBe("ou_sender");
  });

  it("extracts text from a post message", () => {
    const content = JSON.stringify({
      title: "t",
      content: [[{ tag: "at", user_id: "x" }, { tag: "text", text: "帮我写代码" }]],
    });
    const p = parseMessage(ev({ content }));
    expect(p.text).toContain("帮我写代码");
  });

  it("top-level @ (no root_id): threadId = message_id", () => {
    const p = parseMessage(ev({ message_id: "om_top" }));
    expect(p.threadId).toBe("om_top");
  });

  it("in-thread reply (root_id set): threadId = root_id", () => {
    const p = parseMessage(ev({ message_id: "om_reply", root_id: "om_top" }));
    expect(p.threadId).toBe("om_top");
  });

  it("falls back to raw content string on invalid JSON", () => {
    const p = parseMessage(ev({ content: "not json @_user_1 plain" }));
    expect(p.text).toBe("not json plain");
  });
});

describe("sessionKeyOf (scheduler ↔ session must agree)", () => {
  it("top-level @ → message_id", () => {
    expect(sessionKeyOf(ev({ message_id: "om_top" }))).toBe("om_top");
  });
  it("in-thread reply → root_id (NOT thread_id)", () => {
    // The interrupt bug: keying on thread_id (omt_…) split the top-level @ from
    // its replies. sessionKeyOf must use root_id and ignore thread_id.
    const e = ev({ message_id: "om_reply", root_id: "om_top", thread_id: "omt_xyz" });
    expect(sessionKeyOf(e)).toBe("om_top");
  });
  it("matches parseMessage().threadId", () => {
    const e = ev({ message_id: "om_reply", root_id: "om_top", thread_id: "omt_xyz" });
    expect(sessionKeyOf(e)).toBe(parseMessage(e).threadId);
  });
});
