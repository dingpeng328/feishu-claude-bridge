import { describe, it, expect } from "vitest";
import { renderPrompt } from "./prompt.js";
import type { ParsedMessage } from "../lark/message.js";

function parsed(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    threadId: "om_top",
    chatId: "oc_1",
    messageId: "om_1",
    senderOpenId: "ou_sender",
    text: "你好",
    raw: {} as ParsedMessage["raw"],
    ...overrides,
  };
}

describe("renderPrompt", () => {
  it("new thread: includes full context + work dir + user message", () => {
    const out = renderPrompt({ parsed: parsed(), isNewThread: true, workDir: "/tmp/work/om_top" });
    expect(out).toContain("is_new_thread: true");
    expect(out).toContain("/tmp/work/om_top");
    expect(out).toContain("lark-cli api GET /open-apis/im/v1/messages/om_top");
    expect(out).toContain("ou_sender: 你好");
  });

  it("continuation: marks is_new_thread false and omits the bootstrap intro", () => {
    const out = renderPrompt({ parsed: parsed(), isNewThread: false, workDir: "/tmp/work/om_top" });
    expect(out).toContain("is_new_thread: false");
    expect(out).not.toContain("lark-cli api GET");
    expect(out).toContain("ou_sender: 你好");
  });
});
