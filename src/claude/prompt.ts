/**
 * src/claude/prompt.ts
 *
 * Renders a ParsedMessage + thread state into the prompt passed to the local agent CLI.
 * Pure-chat: just thread context + the user's message. No state.json contract,
 * no skill/worktree/MR framing — the bridge takes the agent's streamed reply
 * text verbatim as the card body.
 */

import type { ParsedMessage } from "../lark/message.js";

export interface RenderPromptInput {
  parsed: ParsedMessage;
  isNewThread: boolean;
  /** Absolute cwd the agent subprocess runs in. */
  workDir: string;
}

export function renderPrompt(input: RenderPromptInput): string {
  const { parsed, isNewThread, workDir } = input;

  const lines: string[] = [];

  if (isNewThread) {
    lines.push(
      "你是一个通过飞书话题和用户对话的助手,运行在用户本机的 Agent CLI 里。",
      "请自然、简洁地用中文回复;需要时可以在工作目录里读写文件、执行命令。",
      "",
      "<thread-context>",
      `thread_id:     ${parsed.threadId}`,
      `message_id:    ${parsed.messageId}`,
      `chat_id:       ${parsed.chatId}`,
      `sender:        ${parsed.senderOpenId}`,
      `is_new_thread: true`,
      `工作目录:      ${workDir}(你的 cwd,可读写文件、跑命令;若它是个项目仓库,本地 agent 会按自身规则加载项目指令和技能)`,
      "",
      "如需查看本话题的完整历史(用户可能把背景放在首楼),可执行:",
      `  lark-cli api GET /open-apis/im/v1/messages/${parsed.threadId} --as bot`,
      "</thread-context>",
    );
  } else {
    lines.push(
      "<thread-context>",
      `thread_id:     ${parsed.threadId}`,
      `message_id:    ${parsed.messageId}`,
      `is_new_thread: false(续接同一话题,你的上下文已通过 --resume 恢复)`,
      "</thread-context>",
    );
  }

  lines.push("", "<user-message>", `${parsed.senderOpenId}: ${parsed.text}`, "</user-message>");

  return lines.join("\n");
}
