import { describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "../claude/runner.js";
import {
  CardRenderer,
  _liveMarkdown,
  _optimizeMarkdownStyle,
  _terminalMarkdown,
  type MarkdownStreamController,
  type OutboundCardClient,
} from "./card.js";

function makeHarness() {
  const updates: string[] = [];
  const controller: MarkdownStreamController = {
    messageId: "om_stream",
    setContent: vi.fn(async (content: string) => {
      updates.push(content);
    }),
  };
  const outbound: OutboundCardClient = {
    streamMarkdown: vi.fn(async (_chatId, _replyTo, _opts, producer) => {
      await producer(controller);
      return { messageId: controller.messageId };
    }),
  };
  return { renderer: new CardRenderer({ outbound }), outbound, controller, updates };
}

describe("CardRenderer native markdown stream", () => {
  it("starts a threaded stream with explicit chat and reply ids", async () => {
    const { renderer, outbound, controller } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user", { replyInThread: true });

    expect(card.messageId).toBe("om_stream");
    expect(controller.setContent).toHaveBeenCalledWith(
      "> ⏳ **正在处理**\n> Agent 正在思考或执行任务...",
    );
    expect(outbound.streamMarkdown).toHaveBeenCalledWith(
      "oc_chat",
      "om_user",
      { replyInThread: true },
      expect.any(Function),
    );
    await card.finalize({ success: true, finalText: "完成" });
  });

  it("replaces partial snapshots and commits clean final markdown", async () => {
    const { renderer, updates } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user");
    const first: AgentStreamEvent = {
      type: "text_delta",
      text: "# 初稿",
      raw: { message: { id: "msg_1" } },
    };
    const second: AgentStreamEvent = {
      type: "text_delta",
      text: "# 最终答案\n\n内容",
      raw: { message: { id: "msg_1" } },
    };
    card.handle(first);
    card.handle(second);

    await card.finalize({ success: true });

    expect(updates.at(-1)).toBe("> ✅ **回复完成**\n\n#### 最终答案\n\n内容");
  });

  it("keeps multiple assistant turns separated", async () => {
    const { renderer, updates } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user");
    card.handle({ type: "text_delta", text: "第一段", raw: { message: { id: "msg_1" } } });
    card.handle({ type: "text_delta", text: "第二段", raw: { message: { id: "msg_2" } } });

    await card.finalize({ success: true });

    expect(updates.at(-1)).toBe("> ✅ **回复完成**\n\n第一段\n\n第二段");
  });

  it("shows only generic pre-answer progress and never exposes tool input", async () => {
    const { renderer, updates } = makeHarness();
    const card = await renderer.start("oc_chat", "om_user");
    card.handle({
      type: "tool_use",
      toolName: "Read",
      toolInput: { file_path: "/private/secret/path" },
      raw: {},
    });
    await Promise.resolve();
    await card.finalize({ success: false, failureReason: "token=secret" });

    expect(updates.some((content) => content.includes("正在查找资料..."))).toBe(true);
    expect(updates.at(-1)).toContain("**处理失败**");
    expect(updates.join("\n")).not.toContain("/private/secret/path");
    expect(updates.join("\n")).not.toContain("token=secret");
  });

  it("surfaces stream creation failures from start", async () => {
    const outbound: OutboundCardClient = {
      streamMarkdown: vi.fn(async () => {
        throw new Error("card create failed");
      }),
    };
    const renderer = new CardRenderer({ outbound });

    await expect(renderer.start("oc_chat", "om_user")).rejects.toThrow("card create failed");
  });
});

describe("markdown presentation", () => {
  it("keeps processing status visible after answer text starts", () => {
    expect(_liveMarkdown("正在生成的正文"))
      .toBe("> ⏳ **正在处理**\n\n正在生成的正文");
  });

  it("demotes chat headings without changing fenced code", () => {
    expect(_optimizeMarkdownStyle("# 标题\n\n```md\n# 保持代码\n```"))
      .toBe("#### 标题\n\n```md\n# 保持代码\n```");
  });

  it("adds a compact interruption state below partial output", () => {
    expect(_terminalMarkdown({ bodyText: "已有内容", success: false, interrupted: true }))
      .toBe("> ⏸️ **已被新消息打断**\n> 正在按新消息继续处理。\n\n已有内容");
  });
});
