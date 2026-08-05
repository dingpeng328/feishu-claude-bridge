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
    expect(out).toContain("ou_sender: 你好");
  });

  it("continuation: marks is_new_thread false and omits the bootstrap intro", () => {
    const out = renderPrompt({ parsed: parsed(), isNewThread: false, workDir: "/tmp/work/om_top" });
    expect(out).toContain("is_new_thread: false");
    expect(out).toContain("ou_sender: 你好");
  });

  it("includes the complete pulled topic snapshot as structured chronological context", () => {
    const out = renderPrompt({
      parsed: parsed({ messageId: "om_2", text: "现在怎么办" }),
      isNewThread: false,
      workDir: "/tmp/work",
      threadContext: [
        {
          messageId: "om_root",
          senderId: "ou_a",
          senderName: "小明",
          createTime: "1",
          msgType: "text",
          text: "服务挂了",
        },
        {
          messageId: "om_2",
          senderId: "ou_sender",
          createTime: "2",
          msgType: "text",
          text: "现在怎么办",
        },
      ],
    });

    expect(out).toContain("<thread-history>");
    expect(out.indexOf("服务挂了")).toBeLessThan(out.indexOf("现在怎么办"));
    expect(out).toContain('"sender":"小明"');
    expect(out).toContain("重点回答当前消息");
  });
});
