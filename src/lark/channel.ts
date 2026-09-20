/**
 * src/lark/channel.ts
 *
 * Channel-SDK-backed transport — both inbound events and outbound native
 * CardKit streams route through one live WebSocket channel handle.
 *
 * Why the SDK: it reconnects unconditionally on WS close. This wrapper adds a
 * proactive refresh plus an HTTP history catch-up path because a TCP/WS handle
 * can occasionally stay "connected" while Feishu stops delivering events.
 */

import { createLarkChannel } from "@larksuite/channel";
import type { LarkMessageEvent } from "./transport.js";
import { AsyncQueue } from "./transport.js";
import { extractMessageText } from "./message.js";
import { INITIAL_STREAM_TEXT, type OutboundCardClient } from "./card.js";
import { ManagedMarkdownStream, managedCardSpec, splitManagedMarkdown, type ManagedCardTransport } from "./cardStream.js";
import { DeliveryState } from "./deliveryState.js";
import { TurnJournal } from "./turnJournal.js";

// ---------------------------------------------------------------------------
// Minimal structural slice of the SDK surface we touch.
// (The SDK's aggregated .d.ts is huge; declare only what we use and cast to it.)
// ---------------------------------------------------------------------------

interface ChannelNormalizedMessage {
  messageId?: string;
  chatId?: string;
  chatType?: string;
  senderId?: string;
  threadId?: string;
  rootId?: string;
  createTime?: number;
  content?: string;
  mentionedBot?: boolean;
  mentionAll?: boolean;
  /** Raw im.message.receive_v1 event body (present when includeRawEvent). */
  raw?: unknown;
}

interface ApiMessageItem {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type?: string;
  create_time?: string;
  deleted?: boolean;
  chat_id?: string;
  sender?: { id?: string; id_type?: string; sender_type?: string; sender_name?: string };
  body?: { content?: string };
  mentions?: Array<{ key?: string; id?: string; id_type?: string; name?: string }>;
}

interface LarkChannel {
  botIdentity?: { openId?: string; name?: string } | null;
  on(event: "message", handler: (msg: ChannelNormalizedMessage) => void): void;
  on(event: "reconnecting" | "reconnected", handler: () => void): void;
  on(event: "error", handler: (err: { code?: string; message?: string }) => void): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(
    chatId: string,
    input: { cardId: string },
    opts: { replyTo: string; replyInThread: boolean },
  ): Promise<{ messageId: string }>;
  createCard(card: object): Promise<{ cardId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
  updateCardById(cardId: string, card: object, sequence: number): Promise<void>;
  rawClient: {
    cardkit: {
      v1: {
        cardElement: {
          content(payload: {
            path: { card_id: string; element_id: string };
            data: { content: string; sequence: number; uuid: string };
          }): Promise<{ code?: number; msg?: string } | void>;
        };
      };
    };
    im: {
      v1: {
        chat: {
          list(payload?: {
            params?: { sort_type?: "ByCreateTimeAsc" | "ByActiveTimeDesc"; page_size?: number; page_token?: string };
          }): Promise<{
            code?: number;
            msg?: string;
            data?: { items?: Array<{ chat_id?: string }>; has_more?: boolean; page_token?: string };
          }>;
        };
        message: {
          get(payload: {
            params?: { card_msg_content_type?: "raw_card_content"; with_sender_name?: boolean };
            path: { message_id: string };
          }): Promise<{
            code?: number;
            msg?: string;
            data?: { items?: ApiMessageItem[] };
          }>;
          list(payload: {
            params: {
              container_id_type: string;
              container_id: string;
              start_time?: string;
              end_time?: string;
              sort_type?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
              page_size?: number;
              page_token?: string;
              with_sender_name?: boolean;
              card_msg_content_type?: "raw_card_content";
            };
          }): Promise<{
            code?: number;
            msg?: string;
            data?: { items?: ApiMessageItem[]; has_more?: boolean; page_token?: string };
          }>;
        };
      };
    };
  };
}

const THREAD_HISTORY_TIMEOUT_MS = 15_000;

/** Reject if `p` hasn't settled within `ms`. The underlying call is left to settle on its own. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`[channel] ${label} timed out after ${ms}ms`)), ms);
    t.unref();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Strip the SDK's normalized `<at ...>name</at>` markup from synthesized text. */
function stripAtMarkup(s: string): string {
  return s.replace(/<at\b[^>]*>.*?<\/at>/gi, "").replace(/<at\b[^>]*\/>/gi, "").trim();
}

/**
 * Reconstruct a LarkMessageEvent from the SDK's raw event body, preserving the
 * raw `content` JSON + `root_id` (critical: parseMessage derives the session key
 * from root_id, so an in-thread reply must resolve to the same key as the @ that
 * opened the topic). Falls back to the SDK's normalized fields when raw is absent.
 */
export function channelMsgToLarkEvent(msg: ChannelNormalizedMessage): LarkMessageEvent | null {
  const raw = msg.raw as
    | { event?: { message?: Record<string, unknown>; sender?: { sender_id?: { open_id?: string } } } }
    | undefined;
  const m = raw?.event?.message;
  const senderOpenId = raw?.event?.sender?.sender_id?.open_id ?? msg.senderId;

  const message_id = (m?.["message_id"] as string) ?? msg.messageId;
  const chat_id = (m?.["chat_id"] as string) ?? msg.chatId;
  if (!message_id || !chat_id || !senderOpenId) return null; // can't route without these

  const thread_id =
    (m?.["thread_id"] as string) ?? msg.threadId ?? (m?.["root_id"] as string) ?? msg.rootId;
  const root_id = (m?.["root_id"] as string) ?? msg.rootId ?? undefined;

  const rawContent = typeof m?.["content"] === "string" ? (m["content"] as string) : undefined;
  const content = rawContent ?? JSON.stringify({ text: stripAtMarkup(msg.content ?? "") });

  return {
    message_id,
    chat_id,
    chat_type: (m?.["chat_type"] as string) ?? msg.chatType ?? "group",
    thread_id,
    root_id,
    sender_id: senderOpenId,
    mentions: (m?.["mentions"] as LarkMessageEvent["mentions"]) ?? undefined,
    mentioned_bot: msg.mentionedBot,
    mention_all: msg.mentionAll,
    content,
    create_time: (m?.["create_time"] as string) ?? String(msg.createTime ?? Date.now()),
  };
}

/** Convert one history API item into the same event shape as the WS path. */
export function apiMessageToLarkEvent(
  item: ApiMessageItem,
  botOpenId: string,
): LarkMessageEvent | null {
  const messageId = item.message_id;
  const chatId = item.chat_id;
  const senderId = item.sender?.id;
  const directlyMentioned = item.mentions?.some((mention) => mention.id === botOpenId) === true;
  if (item.deleted || !messageId || !chatId || !senderId || !directlyMentioned) return null;

  return {
    message_id: messageId,
    chat_id: chatId,
    chat_type: "group",
    thread_id: item.thread_id ?? item.root_id,
    root_id: item.root_id,
    sender_id: senderId,
    mentions: item.mentions?.map((mention) => ({
      key: mention.key,
      id: { open_id: mention.id },
      name: mention.name,
    })),
    mentioned_bot: true,
    mention_all: false,
    content: item.body?.content ?? JSON.stringify({ text: "" }),
    create_time: item.create_time ?? String(Date.now()),
    recovered_from_history: true,
  };
}

/** A compact, prompt-safe representation of one message in a Feishu topic. */
export interface ThreadContextMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  createTime: string;
  msgType: string;
  /** Bridge card lifecycle, when this is one of our interactive reply cards. */
  cardStatus?: "thinking" | "streaming" | "success" | "failure" | "interrupted";
  text: string;
}

function parseInteractiveCard(content: string): Record<string, unknown> | undefined {
  try {
    const envelope = JSON.parse(content) as Record<string, unknown>;
    const rawCard = envelope["json_card"] ?? envelope;
    const card = typeof rawCard === "string" ? JSON.parse(rawCard) : rawCard;
    return typeof card === "object" && card !== null
      ? (card as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function findCardField(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCardField(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record[key] !== undefined) return record[key];
  for (const child of Object.values(record)) {
    const found = findCardField(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function fieldString(value: Record<string, unknown>, key: string): string | undefined {
  const found = findCardField(value, key);
  return typeof found === "string" ? found : undefined;
}

function directRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function directString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const found = value?.[key];
  return typeof found === "string" ? found : undefined;
}

/** Reconstruct text from Feishu's compiled CardKit markdown element tree. */
function compiledCardText(value: unknown): string {
  if (Array.isArray(value)) return value.map(compiledCardText).join("");
  const record = directRecord(value);
  if (!record) return "";
  const property = directRecord(record["property"]);
  const tag = directString(record, "tag") ?? directString(property, "tag");
  if (tag === "br") return "\n";

  const content = directString(record, "content") ?? directString(property, "content");
  if (content !== undefined) return content;

  // CardKit compiles Markdown tables into a distinct `table` node rather than
  // nested elements. Preserve its visible cells so delivery verification does
  // not mistake a successfully rendered table for a truncated response.
  const columns = property?.["columns"];
  const rows = property?.["rows"];
  if (tag === "table" && Array.isArray(columns) && Array.isArray(rows)) {
    const tableColumns = columns
      .map(directRecord)
      .filter((column): column is Record<string, unknown> => column !== undefined);
    const cell = (row: unknown, name: string): string => {
      const rowRecord = directRecord(row);
      const column = directRecord(rowRecord?.[name]);
      return compiledCardText(column?.["data"]);
    };
    const header = tableColumns.map(column => directString(column, "displayName") ?? "");
    const body = rows.map(row =>
      tableColumns.map(column => cell(row, directString(column, "name") ?? "")).join(" | "),
    );
    return [`| ${header.join(" | ")} |`, ...body.map(row => `| ${row} |`)].join("\n");
  }

  const elements = property?.["elements"] ?? record["elements"];
  if (Array.isArray(elements)) {
    const text = elements.map(compiledCardText).join("");
    return tag === "blockquote" ? `${text}\n` : text;
  }

  const items = property?.["items"] ?? record["items"];
  if (Array.isArray(items)) return `${items.map(compiledCardText).join("\n")}\n`;
  return "";
}

function cardMarkdownValues(card: Record<string, unknown>): Array<{ text: string; source: boolean }> {
  const contents: Array<{ text: string; source: boolean }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const property = directRecord(record["property"]);
    const tag = directString(record, "tag") ?? directString(property, "tag");
    const elementId =
      directString(record, "element_id")
      ?? directString(record, "elementId")
      ?? directString(property, "element_id")
      ?? directString(property, "elementId");
    if (tag === "markdown" || elementId === "stream_md") {
      const source =
        directString(record, "content")
        ?? directString(property, "content");
      const content = source ?? compiledCardText(record);
      if (content?.trim()) contents.push({ text: content.trim(), source: source !== undefined });
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(card["body"] ?? card);
  return contents;
}

function cardMarkdownContents(card: Record<string, unknown>): string[] {
  return cardMarkdownValues(card).map(value => value.text);
}

function cardSummaryContent(card: Record<string, unknown>): string | undefined {
  const config = directRecord(card["config"]);
  return directString(directRecord(config?.["summary"]), "content");
}

function statusFromCardText(text: string): ThreadContextMessage["cardStatus"] {
  if (text.includes("处理已中断")) return "interrupted";
  if (text.includes("**处理失败**") || text.includes("处理失败")) return "failure";
  if (text.includes("**已被新消息打断**") || text.includes("已被新消息打断")) {
    return "interrupted";
  }
  if (text.includes("**回复完成**") || text.includes("回复完成")) return "success";
  if (text.includes("**正在处理**") || text.includes("正在处理")) return "streaming";
  return undefined;
}

function bridgeCardStatus(
  msgType: string | undefined,
  content: string,
): ThreadContextMessage["cardStatus"] {
  if (msgType !== "interactive") return undefined;
  const card = parseInteractiveCard(content);
  if (!card) return undefined;

  const header = card["header"];
  if (typeof header === "object" && header !== null) {
    const title = fieldString(header as Record<string, unknown>, "content");
    if (title?.startsWith("⏳")) return "thinking";
    if (title?.startsWith("🔧")) return "streaming";
    if (title?.startsWith("✅")) return "success";
    if (title?.startsWith("❌")) return "failure";
    if (title?.startsWith("⏸️")) return "interrupted";
  }

  const elementId =
    findCardField(card["body"], "element_id") ?? findCardField(card["body"], "elementId");
  const streamingMode =
    findCardField(card["config"], "streaming_mode")
    ?? findCardField(card["config"], "streamingMode");
  const cardText = (cardMarkdownContents(card)[0] ?? cardSummaryContent(card) ?? "").split("\n", 1)[0] ?? "";
  const status = statusFromCardText(cardText)
    ?? statusFromCardText(cardSummaryContent(card)?.split("\n", 1)[0] ?? "");
  if (elementId !== "stream_md" && status === undefined) return undefined;
  if (streamingMode === true) return "streaming";
  return status ?? (streamingMode === false ? "success" : undefined);
}

function interactiveCardText(content: string): string {
  const card = parseInteractiveCard(content);
  return card ? cardMarkdownContents(card).join("\n\n") : "";
}

function interactiveCardVerificationText(content: string): string {
  const card = parseInteractiveCard(content);
  if (!card) return "";
  return [cardSummaryContent(card), ...cardMarkdownContents(card)]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function normalizedCardText(text: string): string {
  return text.replace(/\u200b/g, "").replace(/\r\n?/g, "\n").trim();
}

/** Ignore presentation syntax only for Feishu's compiled Markdown response.
 * Both status and the entire body must match; a summary marker alone is never
 * accepted as proof that an answer was delivered.
 */
function visibleMarkdown(text: string): string {
  return normalizedCardText(text)
    .replace(/^\s*```[^\n]*$/gm, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, "");
}

export function finalCardMatches(content: string, expected: object): boolean {
  const actual = parseInteractiveCard(content);
  if (!actual || findCardField(actual["config"], "streaming_mode") === true
    || findCardField(actual["config"], "streamingMode") === true) return false;
  const wanted = cardMarkdownContents(expected as Record<string, unknown>);
  const received = cardMarkdownValues(actual);
  if (wanted.length !== received.length || wanted.length < 2) return false;
  return wanted.every((text, index) =>
    normalizedCardText(text) === normalizedCardText(received[index]?.text ?? "")
    || (!received[index]?.source && visibleMarkdown(text) === visibleMarkdown(received[index]?.text ?? "")));
}

function stripBridgeStatusBlock(markdown: string): string {
  // Managed streaming cards keep the answer element alive with a zero-width
  // prefix before the first token. It is transport scaffolding, not history.
  const lines = markdown.replace(/\u200b/g, "").split("\n");
  const firstLine = lines[0]?.replace(/\s+/g, "") ?? "";
  const rawStatus = /^> (?:⏳ \*\*正在处理\*\*|✅ \*\*回复完成\*\*|❌ \*\*处理失败\*\*|⏸️ \*\*已被新消息打断\*\*)$/u.test(lines[0] ?? "");
  const compiledStatus = /^(?:⏳正在处理|✅回复完成|❌处理失败|⏸️已被新消息打断)$/u.test(firstLine);
  if (!rawStatus && !compiledStatus) {
    return markdown;
  }
  let bodyStart = 1;
  if (rawStatus) {
    while (lines[bodyStart]?.startsWith("> ")) bodyStart++;
  } else {
    while (
      /^(?:⏱️|🔧|正在调用：|正在整理结果|正在按新消息继续处理|请稍后重试)/u.test(
        lines[bodyStart]?.replace(/\s+/g, "") ?? "",
      )
    ) {
      bodyStart++;
    }
  }
  while (lines[bodyStart] === "") bodyStart++;
  return lines.slice(bodyStart).join("\n").trim();
}

function legacyHeaderTitle(card: Record<string, unknown>): string | undefined {
  const header = card["header"];
  return typeof header === "object" && header !== null
    ? fieldString(header as Record<string, unknown>, "content")
    : undefined;
}

// Keep the old title-based cards readable during a rolling upgrade. This
// helper exists separately so history parsing remains explicit and bounded.
function isLegacyBridgeCard(content: string): boolean {
  const card = parseInteractiveCard(content);
  const title = card ? legacyHeaderTitle(card) : undefined;
  return title !== undefined && /^(⏳|🔧|✅|❌|⏸️)/u.test(title);
}

function historyMessageText(item: ApiMessageItem): string {
  const content = item.body?.content ?? "";
  if (item.msg_type === "interactive") {
    const markdown = interactiveCardText(content);
    if (markdown) {
      const body = stripBridgeStatusBlock(markdown);
      if (body) return body;
      const status = bridgeCardStatus(item.msg_type, content);
      if (status === "thinking" || status === "streaming") return "[处理中消息]";
      if (status === "failure") return "[处理失败消息]";
      if (status === "interrupted") return "[已打断消息]";
      if (status === "success") return "[已完成消息]";
      return markdown;
    }
    if (isLegacyBridgeCard(content)) return "[处理中消息]";
  }

  const readable = extractMessageText(content);
  if (readable) return readable;

  let detail = "";
  try {
    const body = JSON.parse(content) as Record<string, unknown>;
    const name = body["file_name"] ?? body["title"];
    if (typeof name === "string" && name.trim()) detail = `: ${name.trim()}`;
  } catch {
    // The type marker below is still useful for non-JSON/unsupported content.
  }
  return `[${item.msg_type ?? "未知类型"}消息${detail}]`;
}

export {
  bridgeCardStatus as _bridgeCardStatus,
  historyMessageText as _historyMessageText,
};

function apiMessageToThreadContext(item: ApiMessageItem): ThreadContextMessage | null {
  const messageId = item.message_id;
  if (item.deleted || !messageId) return null;
  const content = item.body?.content ?? "";
  return {
    messageId,
    senderId: item.sender?.id ?? "system",
    senderName: item.sender?.sender_name,
    createTime: item.create_time ?? "",
    msgType: item.msg_type ?? "unknown",
    cardStatus: bridgeCardStatus(item.msg_type, content),
    text: historyMessageText(item),
  };
}

function eventTimestampMs(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function apiErrorCode(err: unknown): number | undefined {
  const responseData = (err as { response?: { data?: { code?: unknown } } })?.response?.data;
  return typeof responseData?.code === "number" ? responseData.code : undefined;
}

function safeErrorMessage(err: unknown): string {
  const responseData = (err as { response?: { data?: { code?: unknown; msg?: unknown } } })?.response?.data;
  if (responseData && (responseData.code !== undefined || responseData.msg !== undefined)) {
    return `${String(responseData.code ?? "api_error")}: ${String(responseData.msg ?? "request failed")}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// ChannelClient
// ---------------------------------------------------------------------------

export interface ChannelClientOptions {
  appId: string;
  appSecret: string;
  /** Allowed group chat_ids; empty = all groups. */
  allowedChatIds: ReadonlySet<string>;
  /** Durable HTTP catch-up cursor + mention-id ledger. */
  deliveryStatePath: string;
  /**
   * 失聪看门狗阈值(ms)。WS 重连后,飞书网关偶尔会停止往新连接推事件(服务端
   * slot cycling),SDK 不会报错 → bot 静默失聪,@ 消息收不到直到下次重连。
   * 看门狗:**发生过重连、且自该次重连起超过 staleMs 仍无任何入站**时重建 channel。
   * 静默窗口从「重连时刻」起算(不是从最后一条入站起算),所以长期空闲后才刚重连的
   * 健康连接不会被立刻拆掉。默认 300000(5min)。设 0 关闭。env FCB_CHANNEL_STALE_MS 覆盖。
   * 对于“没有 reconnected 事件但已失聪”的情况，另由 channelRefreshMs 定期重建。
   */
  channelStaleMs?: number;
  /**
   * 重建冷却下限(ms):两次重建之间至少间隔这么久,无论触发多少次,把最坏情况下的
   * 抖动限制在「每冷却期最多重建一次」。默认 600000(10min)。设 0 关闭。
   * env FCB_CHANNEL_REBUILD_COOLDOWN_MS 覆盖。
   */
  channelRebuildCooldownMs?: number;
  /** Proactively replace even an apparently healthy WS after this age. Default 20min; 0 disables. */
  channelRefreshMs?: number;
  /** Poll message history to recover missed @mentions. Default 60s; 0 disables. */
  catchUpIntervalMs?: number;
  /** First-start history lookback. Default 5min. */
  catchUpLookbackMs?: number;
}

const STALE_CHECK_INTERVAL_MS = 30_000;
// Silence window AFTER a reconnect before we suspect the slot is deaf. Generous
// on purpose: a freshly-reconnected idle bot (nobody's @-ing it) is the common
// case and must NOT be torn down — only a reconnect followed by a long, total
// silence looks like the "gateway stopped pushing to the new slot" failure.
const DEFAULT_CHANNEL_STALE_MS = 300_000; // 5 min
// Anti-thrash floor: never rebuild more often than this, no matter how many idle
// reconnects fire. Bounds worst-case churn (the 169-rebuilds/hour storm) to one
// rebuild per cooldown. 0 = disabled.
const DEFAULT_CHANNEL_COOLDOWN_MS = 600_000; // 10 min
const DEFAULT_CHANNEL_REFRESH_MS = 20 * 60_000; // 20 min
const DEFAULT_CATCH_UP_INTERVAL_MS = 60_000; // 1 min
const DEFAULT_CATCH_UP_LOOKBACK_MS = 5 * 60_000; // 5 min on the first upgraded start
const MAX_CATCH_UP_WINDOW_MS = 24 * 60 * 60_000; // bound first recovery after a long outage
const CATCH_UP_OVERLAP_MS = 60_000; // overlap + message-id dedup avoids timestamp boundary gaps
const CHAT_DISCOVERY_INTERVAL_MS = 60 * 60_000;
const SDK_TIMEOUT_MS = 15_000;
const SDK_KEEPALIVE_INTERVAL_MS = 15_000;

/** Centralize the SDK knobs so reconnect and native-stream behavior stay testable. */
export function buildChannelSdkOptions(
  opts: Pick<ChannelClientOptions, "appId" | "appSecret" | "allowedChatIds">,
  onUnrecoverable: (err: unknown) => void = () => undefined,
): Parameters<typeof createLarkChannel>[0] {
  return {
    appId: opts.appId,
    appSecret: opts.appSecret,
    source: "feishu-claude-bridge",
    policy: {
      requireMention: true,
      groupAllowlist: [...opts.allowedChatIds],
    },
    includeRawEvent: true,
    wsConfig: { pingTimeout: 15 },
    handshakeTimeoutMs: SDK_TIMEOUT_MS,
    connectTimeoutMs: SDK_TIMEOUT_MS,
    httpTimeoutMs: SDK_TIMEOUT_MS,
    keepalive: {
      enabled: true,
      intervalMs: SDK_KEEPALIVE_INTERVAL_MS,
      onUnrecoverable,
    },
    outbound: {
      streamThrottleMs: 100,
      streamThrottleChars: 50,
      streamInitialText: INITIAL_STREAM_TEXT,
      streamMaxElementChars: 30_000,
      retry: { maxAttempts: 3, baseDelayMs: 500 },
    },
  };
}

export function resolveStaleMs(ctorValue?: number): number {
  let raw: number;
  if (ctorValue !== undefined) raw = ctorValue;
  else {
    const env = process.env["FCB_CHANNEL_STALE_MS"];
    const parsed = env !== undefined ? Number(env) : Number.NaN;
    raw = Number.isFinite(parsed) ? parsed : DEFAULT_CHANNEL_STALE_MS;
  }
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function resolveCooldownMs(ctorValue?: number): number {
  let raw: number;
  if (ctorValue !== undefined) raw = ctorValue;
  else {
    const env = process.env["FCB_CHANNEL_REBUILD_COOLDOWN_MS"];
    const parsed = env !== undefined ? Number(env) : Number.NaN;
    raw = Number.isFinite(parsed) ? parsed : DEFAULT_CHANNEL_COOLDOWN_MS;
  }
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CHANNEL_COOLDOWN_MS;
}

function resolveEnvMs(name: string, ctorValue: number | undefined, fallback: number): number {
  if (ctorValue !== undefined) return Number.isFinite(ctorValue) && ctorValue > 0 ? ctorValue : 0;
  const env = process.env[name];
  const parsed = env !== undefined ? Number(env) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return parsed > 0 ? parsed : 0;
}

export function resolveRefreshMs(ctorValue?: number): number {
  return resolveEnvMs("FCB_CHANNEL_REFRESH_MS", ctorValue, DEFAULT_CHANNEL_REFRESH_MS);
}

export function resolveCatchUpIntervalMs(ctorValue?: number): number {
  return resolveEnvMs("FCB_CATCHUP_INTERVAL_MS", ctorValue, DEFAULT_CATCH_UP_INTERVAL_MS);
}

export function resolveCatchUpLookbackMs(ctorValue?: number): number {
  return resolveEnvMs("FCB_CATCHUP_LOOKBACK_MS", ctorValue, DEFAULT_CATCH_UP_LOOKBACK_MS);
}

/**
 * Pure predicate: should the silent-deaf watchdog rebuild the channel now?
 *
 * Fires only when ALL hold:
 *  - connected, not already rebuilding/closed, staleMs enabled;
 *  - either a reconnect happened and then went silent for `staleMs`, OR the
 *    current channel has reached `refreshMs` age. The second condition heals the
 *    observed "TCP established but no events" state where no reconnect event is
 *    emitted at all;
 *  - silence has lasted staleMs **measured from the reconnect** (not from the
 *    last inbound). This is the key fix for the rebuild storm: a link that was
 *    idle for an hour then reconnected gets a fresh staleMs to prove itself,
 *    instead of being torn down on the very next tick;
 *  - we're past the cooldown floor since the last rebuild (anti-thrash).
 *
 * Exported for unit testing.
 */
export function shouldRebuildChannel(a: {
  connected: boolean;
  rebuilding: boolean;
  closed: boolean;
  lastInboundAt: number;
  lastReconnectAt: number;
  lastRebuildAt: number;
  connectedAt: number;
  now: number;
  staleMs: number;
  cooldownMs: number;
  refreshMs: number;
}): boolean {
  if (a.rebuilding || a.closed) return false;
  if (!a.connected) return a.now - a.lastRebuildAt >= 30_000;
  const staleAfterReconnect =
    a.staleMs > 0 &&
    a.lastReconnectAt > a.lastInboundAt &&
    a.now - a.lastReconnectAt >= a.staleMs;
  const proactiveRefresh =
    a.refreshMs > 0 && a.connectedAt > 0 && a.now - a.connectedAt >= a.refreshMs;
  if (!staleAfterReconnect && !proactiveRefresh) return false;
  if (a.cooldownMs > 0 && a.now - a.lastRebuildAt < a.cooldownMs) return false;
  return true;
}

export class ChannelClient {
  private readonly opts: ChannelClientOptions;
  private readonly queue = new AsyncQueue<LarkMessageEvent>();
  private channel: LarkChannel | null = null;
  private connected = false;
  private closed = false;
  /** ms epoch of the most recent inbound message (advances only on real @). */
  private lastInboundAt = Date.now();
  /** ms epoch of the most recent SDK "reconnected" event (0 = never). */
  private lastReconnectAt = 0;
  /** ms epoch of the most recent watchdog rebuild (0 = never). Anti-thrash floor. */
  private lastRebuildAt = 0;
  /** ms epoch when the current channel handshake completed. */
  private connectedAt = 0;
  /** True while a channel rebuild is in flight (gates the watchdog). */
  private rebuilding = false;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private catchUpTimer: ReturnType<typeof setInterval> | null = null;
  private deliveryState: DeliveryState | null = null;
  private catchUpRunning = false;
  private catchUpPending = false;
  private catchUpDisabledReason: string | null = null;
  private lastChatDiscoveryAt = 0;
  private accepting = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectFailures = 0;
  private journal: TurnJournal | undefined;
  private readonly recoveryIds = new Set<string>();
  private recoveryRunning: Promise<void> | undefined;
  private recoveryTimer: ReturnType<typeof setInterval> | undefined;
  private inboundWrites: Promise<void> = Promise.resolve();

  constructor(opts: ChannelClientOptions) {
    if (!opts.appId || !opts.appSecret) {
      throw new Error("[channel] appId + appSecret are required");
    }
    this.opts = opts;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** IDs Feishu may use for this bot in message history (app_id) and live events (open_id). */
  getBotSenderIds(): string[] {
    const openId = this.channel?.botIdentity?.openId;
    return openId ? [this.opts.appId, openId] : [this.opts.appId];
  }

  /** Async iterator over inbound @-mention events. Connects on first call. */
  async *events(): AsyncIterable<LarkMessageEvent> {
    await this.connect();
    while (!this.closed) {
      const r = await this.queue.next();
      if (r.done) return;
      yield r.value;
    }
  }

  /**
   * Fetch the complete topic snapshot used to answer an in-thread @mention.
   * Feishu's `thread` container contains replies only, so the root message is
   * fetched separately and merged. Pagination continues until `has_more=false`.
   */
  async getThreadContext(
    threadId: string,
    rootMessageId?: string,
    fallbackEvent?: LarkMessageEvent,
  ): Promise<ThreadContextMessage[]> {
    const channel = this.channel;
    if (!channel) throw new Error("[channel] thread history requested before connect()");

    const rawItems: ApiMessageItem[] = [];
    let resolvedThreadId = threadId;
    if (rootMessageId) {
      const root = await withTimeout(
        channel.rawClient.im.v1.message.get({ path: { message_id: rootMessageId } }),
        THREAD_HISTORY_TIMEOUT_MS,
        `get topic root ${rootMessageId}`,
      );
      if (root.code && root.code !== 0) {
        throw new Error(`${root.code}: ${root.msg ?? "message.get failed"}`);
      }
      const rootItems = root.data?.items ?? [];
      rawItems.push(...rootItems);
      resolvedThreadId = rootItems.find((item) => item.thread_id)?.thread_id ?? resolvedThreadId;
    }

    let pageToken: string | undefined;
    const seenPageTokens = new Set<string>();
    while (true) {
      const res = await withTimeout(
        channel.rawClient.im.v1.message.list({
          params: {
            container_id_type: "thread",
            container_id: resolvedThreadId,
            sort_type: "ByCreateTimeAsc",
            page_size: 50,
            page_token: pageToken,
            with_sender_name: true,
            card_msg_content_type: "raw_card_content",
          },
        }),
        THREAD_HISTORY_TIMEOUT_MS,
        `list topic ${resolvedThreadId}`,
      );
      if (res.code && res.code !== 0) {
        throw new Error(`${res.code}: ${res.msg ?? "thread message.list failed"}`);
      }
      rawItems.push(...(res.data?.items ?? []));

      const nextToken = res.data?.page_token;
      if (!res.data?.has_more || !nextToken) break;
      if (seenPageTokens.has(nextToken)) {
        throw new Error(`[channel] repeated page_token while listing topic ${resolvedThreadId}`);
      }
      seenPageTokens.add(nextToken);
      pageToken = nextToken;
    }

    const byMessageId = new Map<string, ThreadContextMessage>();
    for (const item of rawItems) {
      const context = apiMessageToThreadContext(item);
      if (context && !byMessageId.has(context.messageId)) {
        byMessageId.set(context.messageId, context);
      }
    }
    // The receive event can become visible slightly before the history endpoint.
    // Never let that read-after-write race omit the very @mention being answered.
    if (fallbackEvent && !byMessageId.has(fallbackEvent.message_id)) {
      byMessageId.set(fallbackEvent.message_id, {
        messageId: fallbackEvent.message_id,
        senderId: fallbackEvent.sender_id,
        createTime: fallbackEvent.create_time,
        msgType:
          typeof fallbackEvent["message_type"] === "string"
            ? fallbackEvent["message_type"]
            : typeof fallbackEvent["msg_type"] === "string"
              ? fallbackEvent["msg_type"]
              : "text",
        text: extractMessageText(fallbackEvent.content),
      });
    }
    return [...byMessageId.values()].sort(
      (a, b) => eventTimestampMs(a.createTime) - eventTimestampMs(b.createTime),
    );
  }

  /** Idempotently open the WS (+ arm the silent-deaf watchdog). */
  async connect(): Promise<void> {
    if (this.closed || this.connected) return;
    this.deliveryState ??= await DeliveryState.load(this.opts.deliveryStatePath);
    if (!this.journal) {
      this.journal = await TurnJournal.load(`${this.opts.deliveryStatePath}.pending.json`);
      for (const turn of this.journal.list()) this.recoveryIds.add(turn.messageId);
    }
    try { await this.connectChannel(); }
    catch (err) {
      console.warn(`[channel] connect failed; scheduling retry: ${safeErrorMessage(err)}`);
      this.scheduleReconnect();
    }
  }

  private async connectChannel(): Promise<void> {
    const log = (s: string) => console.log(`[channel] ${s}`);
    const channel = createLarkChannel(
      buildChannelSdkOptions(this.opts, (err) => {
        log(`WS keepalive could not reconnect: ${safeErrorMessage(err)}`);
        this.requestCatchUp("sdk-keepalive-failed");
      }),
    ) as unknown as LarkChannel;

    channel.on("message", (msg) => {
      if (this.closed || !this.accepting || this.channel !== channel) return;
      this.lastInboundAt = Date.now(); // inbound arrived → reset watchdog high-water mark
      const ev = channelMsgToLarkEvent(msg);
      if (!ev) {
        log(`dropped unmappable message ${String(msg.messageId ?? "?")}`);
        return;
      }
      this.inboundWrites = this.inboundWrites.then(() => this.acceptEvent(ev)).catch(err => {
        console.error(`[channel] could not durably accept ${ev.message_id}: ${safeErrorMessage(err)}`);
      });
    });
    channel.on("reconnecting", () => log("WS reconnecting…"));
    channel.on("reconnected", () => {
      log("WS reconnected ✓");
      // Record the reconnect. We do NOT rebuild here (that self-feeds a storm);
      // the watchdog rebuilds only if NO inbound arrives within staleMs after this.
      this.lastReconnectAt = Date.now();
      this.requestCatchUp("ws-reconnected");
    });
    channel.on("error", (e) => log(`WS error (non-fatal): ${e?.code ?? ""} ${e?.message ?? ""}`));

    this.channel = channel;
    await channel.connect();
    if (this.closed) { await channel.disconnect(); return; }
    this.connected = true;
    this.reconnectFailures = 0;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connectedAt = Date.now();
    // Fresh connection isn't immediately judged stale.
    this.lastInboundAt = Date.now();
    log(`connected as ${channel.botIdentity?.name ?? "?"} (${channel.botIdentity?.openId ?? "?"})`);
    if (!this.recoveryTimer) {
      this.recoveryTimer = setInterval(() => this.requestRecovery(), 15_000);
      this.recoveryTimer.unref();
    }
    this.requestRecovery();

    // (Re)arm the silent-deaf watchdog. clearInterval first so a rebuild never leaks a timer.
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    const staleMs = resolveStaleMs(this.opts.channelStaleMs);
    const cooldownMs = resolveCooldownMs(this.opts.channelRebuildCooldownMs);
    const refreshMs = resolveRefreshMs(this.opts.channelRefreshMs);
    if (staleMs > 0 || refreshMs > 0) {
      this.staleTimer = setInterval(() => {
        if (this.shouldRebuild(staleMs, cooldownMs, refreshMs, Date.now())) void this.rebuildChannel();
      }, STALE_CHECK_INTERVAL_MS);
      this.staleTimer.unref();
    }

    if (this.catchUpTimer) clearInterval(this.catchUpTimer);
    const catchUpIntervalMs = resolveCatchUpIntervalMs(this.opts.catchUpIntervalMs);
    if (catchUpIntervalMs > 0) {
      this.catchUpTimer = setInterval(() => this.requestCatchUp("poll"), catchUpIntervalMs);
      this.catchUpTimer.unref();
      this.requestCatchUp("connect");
    }
  }

  private async acceptEvent(ev: LarkMessageEvent): Promise<void> {
    if (!this.accepting || this.closed || this.deliveryState?.hasSeen(ev.message_id)) return;
    if (this.recoveryIds.has(ev.message_id)) return;
    if (ev.chat_type !== "p2p" && ev.mentioned_bot !== true) return;
    await this.journal?.begin({
      messageId: ev.message_id, chatId: ev.chat_id,
      replyInThread: !ev.root_id, startedAtMs: Date.now(),
    });
    this.deliveryState?.rememberChat(ev.chat_id);
    this.deliveryState?.rememberMention(ev.message_id, eventTimestampMs(ev.create_time));
    await this.deliveryState?.close();
    console.log(`[channel] dispatching message_id=${ev.message_id}`);
    this.queue.push(ev);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectFailures++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closed) void this.rebuildChannel();
    }, delay);
    this.reconnectTimer.unref();
  }

  /** Called only after agent execution has stopped; retries delivery, never execution. */
  settleTask(messageId: string): void {
    if (this.journal?.get(messageId)) this.recoveryIds.add(messageId);
    this.requestRecovery();
  }

  async discardTask(messageId: string): Promise<void> {
    this.recoveryIds.delete(messageId);
    await this.journal?.remove(messageId);
  }

  private requestRecovery(): void {
    if (this.closed || !this.connected || this.recoveryRunning || !this.journal || !this.recoveryIds.size) return;
    this.recoveryRunning = this.recoverDeliveries().catch(err => {
      console.warn(`[delivery] recovery pending: ${safeErrorMessage(err)}`);
    }).finally(() => { this.recoveryRunning = undefined; });
  }

  private async recoverDeliveries(): Promise<void> {
    for (const id of [...this.recoveryIds]) {
      if (this.closed) return;
      const turn = this.journal!.get(id);
      if (!turn) { this.recoveryIds.delete(id); continue; }
      const channel = this.channel!;
      try {
        const elapsed = Math.max(0, Math.round((Date.now() - turn.startedAtMs) / 1000));
        const status = `> ⏸️ **处理已中断**\n> ⏱️ 距接收消息已过 ${elapsed} 秒\n> 服务中断或回复交付失败，请重新 @ 我继续。`;
        const interruptedCard = managedCardSpec(status, "本轮不会自动重复执行。", false);
        const finalChunks = turn.finalContent ? splitManagedMarkdown(turn.finalContent.body || "\u200b") : undefined;
        const targetCount = Math.max(1, finalChunks?.length ?? turn.cards.length);
        const ambiguous = turn.cards.some(card => !card.messageId && card.sendStartedAtMs !== undefined);
        while (!ambiguous && turn.cards.length < targetCount) {
          const created = await withTimeout(channel.createCard(managedCardSpec("> ⏳ **正在处理**", "正在恢复回复", false)), SDK_TIMEOUT_MS, "create recovery card");
          await this.journal!.recordCard(id, created.cardId);
          turn.cards = this.journal!.get(id)!.cards;
        }
        const plans = turn.cards.map((card, index) => ({
          cardId: card.cardId,
          card: turn.finalContent
            ? managedCardSpec(turn.finalContent.status, finalChunks?.[index] ?? "正文已更新至前方卡片。", false)
            : card.finalCard ?? interruptedCard,
        }));
        await this.journal!.saveFinal(id, plans);
        for (let index = 0; index < turn.cards.length; index++) {
          const card = turn.cards[index]!;
          if (!card.messageId && card.sendStartedAtMs === undefined) {
            await this.journal!.markSending(id, card.cardId);
            const sent = await withTimeout(channel.send(turn.chatId, { cardId: card.cardId }, { replyTo: id, replyInThread: turn.replyInThread }), SDK_TIMEOUT_MS, "send unsent recovery card");
            await this.journal!.recordCard(id, card.cardId, sent.messageId);
            card.messageId = sent.messageId;
          }
          const final = plans[index]!.card;
          const sequence = card.sequence + 1;
          await this.journal!.reserveSequence(id, card.cardId, sequence);
          await withTimeout(channel.updateCardById(card.cardId, final, sequence), SDK_TIMEOUT_MS, "recover original card");
          // A crash during send can leave the remote message id unknown. Do not
          // send another message in that ambiguous state; retain the journal.
          if (!card.messageId || !await this.verifyCard(card.messageId, final)) {
            throw new Error(`original card delivery unconfirmed card_id=${card.cardId}`);
          }
        }
        if (turn.cards.length < targetCount) throw new Error("continuation delivery awaits the original send acknowledgement");
        await this.discardTask(id);
        console.log(`[delivery] recovered original cards for message_id=${id}`);
      } catch (err) {
        console.warn(`[delivery] retry pending message_id=${id}: ${safeErrorMessage(err)}`);
      }
    }
  }

  private async verifyCard(messageId: string, expected: object): Promise<boolean> {
    const result = await withTimeout(this.channel!.rawClient.im.v1.message.get({
      path: { message_id: messageId }, params: { card_msg_content_type: "raw_card_content", with_sender_name: false },
    }), SDK_TIMEOUT_MS, "verify final card body");
    if (result.code) throw new Error(`${result.code}: ${result.msg}`);
    const item = result.data?.items?.find(item => item.message_id === messageId);
    return !!item?.body?.content && finalCardMatches(item.body.content, expected);
  }

  stopAccepting(): void {
    this.accepting = false;
    this.queue.close();
  }

  /** Thin instance wrapper over the pure {@link shouldRebuildChannel} predicate. */
  private shouldRebuild(staleMs: number, cooldownMs: number, refreshMs: number, now: number): boolean {
    return shouldRebuildChannel({
      connected: this.connected,
      rebuilding: this.rebuilding,
      closed: this.closed,
      lastInboundAt: this.lastInboundAt,
      lastReconnectAt: this.lastReconnectAt,
      lastRebuildAt: this.lastRebuildAt,
      connectedAt: this.connectedAt,
      now,
      staleMs,
      cooldownMs,
      refreshMs,
    });
  }

  private requestCatchUp(reason: "connect" | "ws-reconnected" | "sdk-keepalive-failed" | "poll"): void {
    if (this.closed || !this.deliveryState || this.catchUpDisabledReason) return;
    if (this.catchUpRunning) {
      this.catchUpPending = true;
      return;
    }
    this.catchUpRunning = true;
    void (async () => {
      let nextReason = reason;
      do {
        this.catchUpPending = false;
        try {
          await this.catchUpOnce(nextReason);
        } catch (err) {
          console.warn(`[catchup] ${nextReason} failed; cursor not advanced: ${safeErrorMessage(err)}`);
        }
        nextReason = "poll";
      } while (this.catchUpPending && !this.closed);
    })().finally(() => {
      this.catchUpRunning = false;
    });
  }

  private async catchUpOnce(
    reason: "connect" | "ws-reconnected" | "sdk-keepalive-failed" | "poll",
  ): Promise<void> {
    const channel = this.channel;
    const state = this.deliveryState;
    const botOpenId = channel?.botIdentity?.openId;
    if (!channel || !state || !botOpenId || !this.accepting || this.closed) return;

    const endMs = Date.now();
    const lookbackMs = resolveCatchUpLookbackMs(this.opts.catchUpLookbackMs);
    if (!(lookbackMs > 0)) return;
    const startMs = Math.max(
      state.cursorMs > 0 ? state.cursorMs - CATCH_UP_OVERLAP_MS : endMs - lookbackMs,
      endMs - MAX_CATCH_UP_WINDOW_MS,
    );
    const chatIds = await this.catchUpChatIds(channel, state, endMs);
    if (chatIds.length === 0) throw new Error("no bot chat ids available for history catch-up");

    const recovered: LarkMessageEvent[] = [];
    let failedChats = 0;
    for (const chatId of chatIds) {
      try {
        const items = await this.listMessages(channel, chatId, startMs, endMs);
        for (const item of items) {
          const ev = apiMessageToLarkEvent({ ...item, chat_id: item.chat_id ?? chatId }, botOpenId);
          if (ev && !state.hasSeen(ev.message_id)) recovered.push(ev);
        }
      } catch (err) {
        if (apiErrorCode(err) === 230027) {
          this.disableCatchUp("missing Feishu app scope im:message.group_msg");
          return;
        }
        failedChats++;
        console.warn(`[catchup] chat ${chatId} history query failed: ${safeErrorMessage(err)}`);
      }
    }

    recovered.sort((a, b) => eventTimestampMs(a.create_time) - eventTimestampMs(b.create_time));
    for (const ev of recovered) {
      if (this.closed || !this.accepting) return;
      if (state.hasSeen(ev.message_id)) continue; // a live event may have won the race
      console.log(
        `[catchup] recovered mention message_id=${ev.message_id} chat=${ev.chat_id} root=${ev.root_id ?? "·"}`,
      );
      // Serialize live and catch-up acceptance so their dedup check is atomic.
      const accept = this.inboundWrites.then(() => this.acceptEvent(ev));
      this.inboundWrites = accept.catch(() => undefined);
      await accept;
    }

    if (failedChats === 0 && this.accepting && !this.closed) state.advanceCursor(endMs);
    if (reason !== "poll" || recovered.length > 0) {
      console.log(
        `[catchup] ${reason}: chats=${chatIds.length} recovered=${recovered.length} failed=${failedChats}`,
      );
    }
  }

  private async catchUpChatIds(
    channel: LarkChannel,
    state: DeliveryState,
    now: number,
  ): Promise<string[]> {
    if (this.opts.allowedChatIds.size > 0) {
      for (const id of this.opts.allowedChatIds) state.rememberChat(id);
      return [...this.opts.allowedChatIds];
    }

    const ids = new Set(state.knownChatIds);
    if (now - this.lastChatDiscoveryAt >= CHAT_DISCOVERY_INTERVAL_MS) {
      try {
        let pageToken: string | undefined;
        for (let page = 0; page < 20; page++) {
          const res = await channel.rawClient.im.v1.chat.list({
            params: { sort_type: "ByActiveTimeDesc", page_size: 100, page_token: pageToken },
          });
          if (res.code && res.code !== 0) throw new Error(`${res.code}: ${res.msg ?? "chat.list failed"}`);
          for (const item of res.data?.items ?? []) {
            if (item.chat_id) {
              ids.add(item.chat_id);
              state.rememberChat(item.chat_id);
            }
          }
          if (!res.data?.has_more || !res.data.page_token) break;
          pageToken = res.data.page_token;
        }
        this.lastChatDiscoveryAt = now;
      } catch (err) {
        if (ids.size === 0) throw err;
        console.warn(`[catchup] chat discovery failed; using persisted chat ids: ${safeErrorMessage(err)}`);
      }
    }
    return [...ids];
  }

  private disableCatchUp(reason: string): void {
    if (this.catchUpDisabledReason) return;
    this.catchUpDisabledReason = reason;
    if (this.catchUpTimer) {
      clearInterval(this.catchUpTimer);
      this.catchUpTimer = null;
    }
    console.warn(`[catchup] disabled for this process: ${reason}`);
  }

  private async listMessages(
    channel: LarkChannel,
    chatId: string,
    startMs: number,
    endMs: number,
  ): Promise<ApiMessageItem[]> {
    const items: ApiMessageItem[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: "chat",
          container_id: chatId,
          start_time: String(Math.floor(startMs / 1000)),
          end_time: String(Math.ceil(endMs / 1000)),
          sort_type: "ByCreateTimeAsc",
          page_size: 50,
          page_token: pageToken,
        },
      });
      if (res.code && res.code !== 0) throw new Error(`${res.code}: ${res.msg ?? "message.list failed"}`);
      items.push(...(res.data?.items ?? []));
      if (!res.data?.has_more || !res.data.page_token) break;
      pageToken = res.data.page_token;
    }
    return items;
  }

  /**
   * Silent-deaf recovery: tear down the (apparently deaf) handle and build a
   * fresh one. Only the channel handle is replaced — the queue is untouched, so
   * in-flight turns + ordering survive. Never throws out of the interval.
   */
  private async rebuildChannel(): Promise<void> {
    if (this.closed || this.rebuilding) return;
    const log = (s: string) => console.log(`[channel] ${s}`);
    this.rebuilding = true;
    this.lastRebuildAt = Date.now(); // stamp before teardown so the cooldown floor counts from here
    try {
      const ageMs = Date.now() - this.connectedAt;
      log(`rebuilding channel (silent-deaf guard; age=${ageMs}ms, inbound_silence=${Date.now() - this.lastInboundAt}ms)`);
      try {
        await this.channel?.disconnect();
      } catch {
        // ignore: handle is being replaced anyway
      }
      this.connected = false;
      if (this.closed) return;
      await this.connectChannel(); // re-handshake, re-subscribe, re-arm watchdog
    } catch (e) {
      log(`channel rebuild failed (will retry next tick): ${e instanceof Error ? e.message : String(e)}`);
      this.scheduleReconnect();
    } finally {
      this.rebuilding = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopAccepting();
    clearTimeout(this.reconnectTimer);
    clearInterval(this.recoveryTimer);
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    if (this.catchUpTimer) {
      clearInterval(this.catchUpTimer);
      this.catchUpTimer = null;
    }
    this.queue.close();
    try {
      await this.channel?.disconnect();
    } catch {
      // best-effort: handle is being torn down anyway
    }
    this.connected = false;
    this.connectedAt = 0;
    await this.deliveryState?.close();
    await this.inboundWrites;
    await this.journal?.close();
  }

  /** Managed two-element CardKit stream bound to the active channel handle. */
  outboundCardClient(): OutboundCardClient {
    const client = this;
    const getChannel = (): LarkChannel => {
      if (!this.channel) throw new Error("[channel] outbound called before connect()");
      return this.channel;
    };
    const makeTransport = (turnId: string): ManagedCardTransport => ({
      async createCard(card) {
        const created = await withTimeout(
          getChannel().createCard(card),
          SDK_TIMEOUT_MS,
          "create managed CardKit entity",
        );
        await client.journal?.recordCard(turnId, created.cardId);
        return created;
      },
      async sendCard(chatId, cardId, replyToMessageId, replyInThread) {
        await client.journal?.markSending(turnId, cardId);
        const sent = await withTimeout(
          getChannel().send(
            chatId,
            { cardId },
            { replyTo: replyToMessageId, replyInThread },
          ),
          SDK_TIMEOUT_MS,
          `send managed CardKit entity ${cardId}`,
        );
        await client.journal?.recordCard(turnId, cardId, sent.messageId);
        return sent;
      },
      async updateElement(cardId, elementId, content, sequence) {
        await client.journal?.reserveSequence(turnId, cardId, sequence);
        const res = await withTimeout(
          getChannel().rawClient.cardkit.v1.cardElement.content({
            path: { card_id: cardId, element_id: elementId },
            data: {
              content,
              sequence,
              uuid: `c_${cardId}_${sequence}`,
            },
          }),
          SDK_TIMEOUT_MS,
          `update CardKit element ${cardId}/${elementId}`,
        );
        if (res && res.code && res.code !== 0) {
          throw new Error(`${res.code}: ${res.msg ?? "cardElement.content failed"}`);
        }
      },
      async updateCard(cardId, card, sequence) {
        await client.journal?.reserveSequence(turnId, cardId, sequence);
        await withTimeout(
          getChannel().updateCardById(cardId, card, sequence),
          SDK_TIMEOUT_MS,
          `update managed CardKit entity ${cardId}`,
        );
      },
      async saveFinal(plans) { await client.journal?.saveFinal(turnId, plans); },
      async saveFinalContent(status, body) { await client.journal?.saveFinalContent(turnId, status, body); },
      async verifyCard(messageId, card) { return client.verifyCard(messageId, card); },
    });
    const activeStreamCards = new Map<string, ManagedMarkdownStream>();
    return {
      async streamMarkdown(chatId, replyToMessageId, opts, producer) {
        await client.journal?.begin({ messageId: replyToMessageId, chatId, replyInThread: opts.replyInThread, startedAtMs: Date.now() });
        const controller = await ManagedMarkdownStream.start({
          transport: makeTransport(replyToMessageId),
          chatId,
          replyToMessageId,
          replyInThread: opts.replyInThread,
          initialStatus: opts.initialStatus,
        });
        activeStreamCards.set(controller.messageId, controller);

        let producerError: unknown;
        try {
          await producer(controller);
        } catch (err) {
          producerError = err;
        }

        try {
          await controller.complete();
        } catch (err) {
          if (producerError !== undefined) {
            throw new AggregateError(
              [producerError, err],
              `managed CardKit producer and finalization failed for ${controller.messageId}`,
            );
          }
          throw err;
        }
        if (producerError !== undefined) throw producerError;
        await client.discardTask(replyToMessageId);
        return { messageId: controller.messageId };
      },
      async replaceCard(messageId, card) {
        const controller = activeStreamCards.get(messageId);
        if (controller) {
          await controller.replaceHead(card);
          return;
        }
        await withTimeout(
          getChannel().updateCard(messageId, card),
          SDK_TIMEOUT_MS,
          `replace final card ${messageId}`,
        );
      },
      async readCardMarkdown(messageId) {
        const res = await withTimeout(
          getChannel().rawClient.im.v1.message.get({
            params: { card_msg_content_type: "raw_card_content", with_sender_name: false },
            path: { message_id: messageId },
          }),
          SDK_TIMEOUT_MS,
          `read final card ${messageId}`,
        );
        if (res.code && res.code !== 0) {
          throw new Error(`${res.code}: ${res.msg ?? "message.get failed"}`);
        }
        const item = res.data?.items?.find((candidate) => candidate.message_id === messageId)
          ?? res.data?.items?.[0];
        if (item?.msg_type !== "interactive" || !item.body?.content) return undefined;
        return interactiveCardVerificationText(item.body.content) || undefined;
      },
      releaseCard(messageId) {
        activeStreamCards.delete(messageId);
      },
    };
  }
}
