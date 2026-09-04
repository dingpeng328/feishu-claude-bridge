/**
 * src/claude/prompt.ts
 *
 * Renders a ParsedMessage + thread state into the prompt passed to the local agent CLI.
 * Pure-chat: just thread context + the user's message. No state.json contract,
 * no skill/worktree/MR framing — the bridge takes the agent's streamed reply
 * text verbatim as the card body.
 */

import type { ParsedMessage } from "../lark/message.js";
import type { ThreadContextMessage } from "../lark/channel.js";

export const DEFAULT_AGENT_SYSTEM_PROMPT = [
  "你是一个通过飞书话题和用户对话的助手,运行在用户本机的 Agent CLI 里。",
  "请自然、简洁地用中文回复;需要时可以在工作目录里读写文件、执行命令。",
].join("\n");

export interface RenderPromptInput {
  parsed: ParsedMessage;
  isNewThread: boolean;
  /** Absolute cwd the agent subprocess runs in. */
  workDir: string;
  /** Configurable role/behavior instructions. Applied when a new agent session starts. */
  systemPrompt?: string;
  /** Complete Feishu topic snapshot, present for an @mention inside a group topic. */
  threadContext?: ThreadContextMessage[];
}

export function renderPrompt(input: RenderPromptInput): string {
  const {
    parsed,
    isNewThread,
    workDir,
    systemPrompt = DEFAULT_AGENT_SYSTEM_PROMPT,
    threadContext,
  } = input;

  const lines: string[] = [];

  if (isNewThread) {
    lines.push(
      systemPrompt.trim(),
      "",
      "<thread-context>",
      `thread_id:     ${parsed.threadId}`,
      `message_id:    ${parsed.messageId}`,
      `chat_id:       ${parsed.chatId}`,
      `sender:        ${parsed.senderOpenId}`,
      `is_new_thread: true`,
      `工作目录:      ${workDir}(你的 cwd,可读写文件、跑命令;若它是个项目仓库,本地 agent 会按自身规则加载项目指令和技能)`,
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

  if (threadContext !== undefined) {
    lines.push(
      "",
      "<thread-history>",
      "这是收到本次 @ 时从飞书拉取的完整话题快照，已按时间升序排列。请综合全部讨论，重点回答当前消息。",
      ...threadContext.map((message) =>
        JSON.stringify({
          message_id: message.messageId,
          sender: message.senderName ?? message.senderId,
          sender_id: message.senderId,
          create_time: message.createTime,
          msg_type: message.msgType,
          text: message.text,
        }),
      ),
      "</thread-history>",
    );
  }

  lines.push("", "<user-message>", `${parsed.senderOpenId}: ${parsed.text}`, "</user-message>");

  return lines.join("\n");
}
