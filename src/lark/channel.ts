/**
 * src/lark/channel.ts
 *
 * Channel-SDK-backed transport — both inbound (events) and outbound (card
 * create/patch) route through ONE live WebSocket handle from the vendored
 * Feishu SDK's `createLarkChannel`.
 *
 * Why the SDK: it reconnects unconditionally on WS close. This wrapper adds a
 * proactive refresh plus an HTTP history catch-up path because a TCP/WS handle
 * can occasionally stay "connected" while Feishu stops delivering events.
 */

import { createLarkChannel } from "@larksuiteoapi/node-sdk";
import type { LarkMessageEvent } from "./transport.js";
import { AsyncQueue } from "./transport.js";
import { extractMessageText } from "./message.js";
import type { OutboundCardClient } from "./card.js";
import { DeliveryState } from "./deliveryState.js";

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
  /** Raw im.message.receive_v1 event body (present when includeRawInMessage). */
  raw?: unknown;
}

interface RawReplyResult {
  data?: { message_id?: string };
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
  updateCard(messageId: string, card: object): Promise<void>;
  rawClient: {
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
          reply(payload: {
            path: { message_id: string };
            data: { content: string; msg_type: string; reply_in_thread?: boolean };
          }): Promise<RawReplyResult>;
          get(payload: { path: { message_id: string } }): Promise<{
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

// Outbound card calls (reply / updateCard) ride HTTP but share the SDK handle
// that the WS churn tears down. On a flapping connection they can hang ("socket
// hang up" / no response), which would wedge handleOne and leak a concurrency
// slot. Bound every outbound call so the caller always settles.
const OUTBOUND_TIMEOUT_MS = 15_000;
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
  text: string;
}

function historyMessageText(item: ApiMessageItem): string {
  const content = item.body?.content ?? "";
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

function apiMessageToThreadContext(item: ApiMessageItem): ThreadContextMessage | null {
  const messageId = item.message_id;
  if (item.deleted || !messageId) return null;
  return {
    messageId,
    senderId: item.sender?.id ?? "system",
    senderName: item.sender?.sender_name,
    createTime: item.create_time ?? "",
    msgType: item.msg_type ?? "unknown",
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
  if (!a.connected || a.rebuilding || a.closed) return false;
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

  constructor(opts: ChannelClientOptions) {
    if (!opts.appId || !opts.appSecret) {
      throw new Error("[channel] appId + appSecret are required");
    }
    this.opts = opts;
  }

  isConnected(): boolean {
    return this.connected;
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
    await this.connectChannel();
  }

  private async connectChannel(): Promise<void> {
    const log = (s: string) => console.log(`[channel] ${s}`);
    const channel = createLarkChannel({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      // Only deliver group messages that directly @mention this bot. The handler
      // repeats the same check as a defense-in-depth routing boundary.
      policy: {
        requireMention: true,
        groupAllowlist: [...this.opts.allowedChatIds],
      },
      includeRawInMessage: true,
    } as Parameters<typeof createLarkChannel>[0]) as unknown as LarkChannel;

    channel.on("message", (msg) => {
      if (this.closed) return;
      this.lastInboundAt = Date.now(); // inbound arrived → reset watchdog high-water mark
      const ev = channelMsgToLarkEvent(msg);
      if (!ev) {
        log(`dropped unmappable message ${String(msg.messageId ?? "?")}`);
        return;
      }
      this.deliveryState?.rememberChat(ev.chat_id);
      if (ev.mentioned_bot === true) {
        if (this.deliveryState?.hasSeen(ev.message_id)) {
          log(`duplicate mention skipped message_id=${ev.message_id}`);
          return;
        }
        this.deliveryState?.rememberMention(ev.message_id, eventTimestampMs(ev.create_time));
      }
      log(
        `dispatching message_id=${ev.message_id} root_id=${ev.root_id ?? "·"} thread_id=${ev.thread_id ?? "·"}`,
      );
      this.queue.push(ev);
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
    this.connected = true;
    this.connectedAt = Date.now();
    // Fresh connection isn't immediately judged stale.
    this.lastInboundAt = Date.now();
    log(`connected as ${channel.botIdentity?.name ?? "?"} (${channel.botIdentity?.openId ?? "?"})`);

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

  private requestCatchUp(reason: "connect" | "ws-reconnected" | "poll"): void {
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

  private async catchUpOnce(reason: "connect" | "ws-reconnected" | "poll"): Promise<void> {
    const channel = this.channel;
    const state = this.deliveryState;
    const botOpenId = channel?.botIdentity?.openId;
    if (!channel || !state || !botOpenId) return;

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
      if (state.hasSeen(ev.message_id)) continue; // a live event may have won the race
      state.rememberChat(ev.chat_id);
      state.rememberMention(ev.message_id, eventTimestampMs(ev.create_time));
      console.log(
        `[catchup] recovered mention message_id=${ev.message_id} chat=${ev.chat_id} root=${ev.root_id ?? "·"}`,
      );
      this.queue.push(ev);
    }

    if (failedChats === 0) state.advanceCursor(endMs);
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
    } finally {
      this.rebuilding = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
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
  }

  /**
   * Outbound card transport bound to this same channel handle. card.ts owns all
   * card-JSON building; this only delivers the leaf network calls.
   */
  outboundCardClient(): OutboundCardClient {
    const getChannel = (): LarkChannel => {
      if (!this.channel) throw new Error("[channel] outbound called before connect()");
      return this.channel;
    };
    return {
      async createCard(replyToMessageId, cardJson, opts) {
        const res = await withTimeout(
          getChannel().rawClient.im.v1.message.reply({
            path: { message_id: replyToMessageId },
            data: {
              content: cardJson,
              msg_type: "interactive",
              reply_in_thread: opts.replyInThread,
            },
          }),
          OUTBOUND_TIMEOUT_MS,
          "createCard reply",
        );
        const messageId = res.data?.message_id;
        if (!messageId) {
          throw new Error(`[channel] reply returned no message_id (replyTo=${replyToMessageId})`);
        }
        return { messageId };
      },
      async patchCard(messageId, cardJson) {
        // updateCard takes an OBJECT — parse the stringified card (passing a
        // string would double-encode and Feishu rejects it).
        await withTimeout(
          getChannel().updateCard(messageId, JSON.parse(cardJson) as object),
          OUTBOUND_TIMEOUT_MS,
          "patchCard updateCard",
        );
      },
    };
  }
}
