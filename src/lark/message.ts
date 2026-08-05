/**
 * src/lark/message.ts
 *
 * Extract downstream-relevant fields from a raw LarkMessageEvent. Pure
 * extraction — never downloads attachments or calls any external service.
 * It keeps text extraction and the session key (threadId), which is what topic
 * continuity depends on.
 */

import type { LarkMessageEvent } from "./transport.js";

export interface ParsedMessage {
  /** Session key — groups all messages in one logical conversation (topic). */
  threadId: string;
  chatId: string;
  messageId: string;
  senderOpenId: string;
  /** Plain text with @-mention placeholders stripped. */
  text: string;
  /** Original event, passed through for logging / debugging. */
  raw: LarkMessageEvent;
}

/** Feishu inserts "@_user_1 " / "@_all " placeholders for @-mentions. */
const AT_PLACEHOLDER_RE = /@_\w+\s*/g;

function stripAtPlaceholders(text: string): string {
  return text.replace(AT_PLACEHOLDER_RE, "").trim();
}

/**
 * The session/topic key for an event — groups all messages of one logical
 * conversation:
 *   - top-level @bot      → no root_id → message_id (this msg IS the topic root)
 *   - reply inside thread → root_id set → root_id (points back to the root @)
 *
 * MUST be used by BOTH the scheduler (run() interrupt grouping) AND session
 * lookup, or the two disagree for "top-level + in-thread reply" and interrupts
 * never match. (Feishu's `thread_id`/`omt_…` differs from the root message id,
 * so keying on thread_id splits them apart — that was the interrupt bug.)
 */
export function sessionKeyOf(event: LarkMessageEvent): string {
  return typeof event.root_id === "string" && event.root_id ? event.root_id : event.message_id;
}

/**
 * Recursively collect text from a parsed Feishu `post` content tree.
 * post content is [[{tag, text?}]] — a 2-D array of paragraph rows.
 * @-mention nodes are skipped (handled by AT_PLACEHOLDER_RE on the final string).
 */
function extractPostText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractPostText).filter(Boolean).join(" ");
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj["tag"] === "at") return "";
    if (typeof obj["text"] === "string") return obj["text"];
    for (const key of ["content", "elements", "body"]) {
      if (key in obj) return extractPostText(obj[key]);
    }
  }
  return "";
}

/** Parse a Feishu message body JSON string and extract readable text. */
export function extractMessageText(content: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return stripAtPlaceholders(content);
  }

  let raw = "";
  if (typeof parsed["text"] === "string") {
    // message_type = "text": { "text": "..." }
    raw = parsed["text"];
  } else if (parsed["content"] !== undefined) {
    // message_type = "post": { "title", "content": [[{tag, text}]] }
    raw = extractPostText(parsed["content"]);
  } else {
    // post with a top-level locale key (zh_cn / en_us / ...)
    const locale = parsed["zh_cn"] ?? parsed["en_us"] ?? parsed["zh_hk"] ?? parsed["ja_jp"];
    if (locale !== undefined) raw = extractPostText(locale);
    // Interactive cards and a few other structured message bodies keep their
    // readable markdown under `elements` rather than `content`.
    else raw = extractPostText(parsed);
  }

  return stripAtPlaceholders(raw.trim());
}

export function parseMessage(event: LarkMessageEvent): ParsedMessage {
  return {
    threadId: sessionKeyOf(event), // same key the scheduler uses (see sessionKeyOf)
    chatId: event.chat_id,
    messageId: event.message_id,
    senderOpenId: event.sender_id,
    text: extractMessageText(event.content),
    raw: event,
  };
}
