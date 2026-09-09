/**
 * Renders one agent turn through the official Channel SDK's native CardKit
 * markdown stream. The SDK owns CardKit entities, throttling, and rollover for
 * long replies; this module only maintains the current answer snapshot.
 */

import type { AgentStreamEvent } from "../claude/runner.js";

export interface MarkdownStreamController {
  readonly messageId: string;
  setContent(fullContent: string): Promise<void>;
}

export interface OutboundCardClient {
  streamMarkdown(
    chatId: string,
    replyToMessageId: string,
    opts: { replyInThread: boolean },
    producer: (controller: MarkdownStreamController) => Promise<void>,
  ): Promise<{ messageId: string }>;
  /** Force-replace the streamed message with an ordinary, non-streaming card. */
  replaceCard(messageId: string, card: object): Promise<void>;
  /** Read the rendered markdown stored by Feishu for final-state verification. */
  readCardMarkdown(messageId: string): Promise<string | undefined>;
  /** Release transport metadata retained only for this active stream. */
  releaseCard?(messageId: string): void;
}

export interface CardRendererOptions {
  outbound: OutboundCardClient;
  /** Injectable clock for deterministic duration rendering in tests. */
  now?: () => number;
  /** Injectable sleep for deterministic retry tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CardHandle {
  /** message_id of the first streaming card. */
  messageId: string;
  /** Accumulate a stream event. Live update failures are logged and retried by the next snapshot. */
  handle(event: AgentStreamEvent): void;
  /** Finish the native stream and wait until CardKit has committed the final content. */
  finalize(opts: {
    finalText?: string;
    success: boolean;
    failureReason?: string;
    interrupted?: boolean;
  }): Promise<void>;
}

const FAILURE_MARKER = "**处理失败**";
const INTERRUPTED_MARKER = "**已被新消息打断**";
const PROCESSING_STATUS = "> ⏳ **正在处理**";
const SUCCESS_STATUS = "> ✅ **回复完成**";
export const INITIAL_STREAM_TEXT = `${PROCESSING_STATUS}\n> Agent 正在思考或执行任务...`;
const STATIC_FINAL_CARD_MAX_CHARS = 29_000;
const FINAL_REPLACE_ATTEMPTS = 3;
const FINAL_RETRY_BASE_DELAY_MS = 300;
const FINAL_VERIFY_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function conciseError(err: unknown): string {
  const responseData = (err as { response?: { data?: { code?: unknown; msg?: unknown } } })?.response?.data;
  if (responseData && (responseData.code !== undefined || responseData.msg !== undefined)) {
    return `${String(responseData.code ?? "api_error")}: ${String(responseData.msg ?? "request failed")}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function truncateSummary(text: string, max = 50): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

function staticFinalCard(markdown: string): object {
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      summary: { content: truncateSummary(markdown) },
    },
    body: {
      elements: [{ tag: "markdown", element_id: "stream_md", content: markdown }],
    },
  };
}

/** Remove raw tool-call markup that can occasionally leak into model text. */
function stripLeakedToolMarkup(text: string): string {
  return text
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .replace(/<(?:function_calls|invoke|parameter)\b[\s\S]*$/i, "")
    .replace(/<\/?(?:function_calls|invoke|parameter)\b[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Card markdown renders large H1/H2 headings too aggressively in chat. Demote
 * headings outside fenced code while leaving code samples byte-for-byte intact.
 */
function optimizeMarkdownStyle(text: string): string {
  const normalized = stripLeakedToolMarkup(text.replace(/\r\n?/g, "\n"));
  if (!normalized) return "";

  let inFence = false;
  const lines = normalized.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    if (/^#{1,3}\s/.test(line)) return line.replace(/^#{1,3}/, "####");
    if (/^#{4,6}\s/.test(line)) return line.replace(/^#{4,6}/, "#####");
    return line;
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function progressText(toolName: string): string {
  const name = toolName.toLowerCase();
  if (/(read|search|find|fetch|web)/.test(name)) return "正在查找资料...";
  if (/(write|edit|patch)/.test(name)) return "正在整理结果...";
  if (/(bash|exec|command|shell|test)/.test(name)) return "正在执行检查...";
  return "正在处理...";
}

function liveMarkdown(bodyText: string, progress?: string): string {
  const body = optimizeMarkdownStyle(bodyText);
  if (body) return `${PROCESSING_STATUS}\n\n${body}`;
  return progress ? `${PROCESSING_STATUS}\n> ${progress}` : INITIAL_STREAM_TEXT;
}

function formatDuration(elapsedMs: number): string {
  const safeMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  if (safeMs < 1000) return "不到 1 秒";

  const totalSeconds = Math.max(1, Math.round(safeMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分钟`);
  if (seconds > 0) parts.push(`${seconds} 秒`);
  return parts.join(" ");
}

function terminalMarkdown(opts: {
  bodyText: string;
  success: boolean;
  interrupted?: boolean;
  elapsedMs: number;
}): string {
  const body = optimizeMarkdownStyle(opts.bodyText);
  const duration = `> ⏱️ 处理耗时：${formatDuration(opts.elapsedMs)}`;
  if (opts.interrupted) {
    const status = `> ⏸️ ${INTERRUPTED_MARKER}\n${duration}\n> 正在按新消息继续处理。`;
    return body ? `${status}\n\n${body}` : status;
  }
  if (!opts.success) {
    const status = `> ❌ ${FAILURE_MARKER}\n${duration}\n> 请稍后重试，详细原因已写入服务日志。`;
    return body ? `${status}\n\n${body}` : status;
  }
  const answer = body || "本轮没有拿到 agent 的回复，请再 @ 我一次重试。";
  return `${SUCCESS_STATUS}\n${duration}\n\n${answer}`;
}

interface RenderState {
  textBuffer: string;
  /** Raw message id of the currently accumulating assistant turn. */
  currentRawMsgId: string | null;
}

function extractRawMessageId(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const message = record["message"];
  if (typeof message === "object" && message !== null) {
    const id = (message as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
  }
  const item = record["item"];
  if (typeof item !== "object" || item === null) return null;
  const itemId = (item as Record<string, unknown>)["id"];
  return typeof itemId === "string" ? itemId : null;
}

class CardHandleImpl implements CardHandle {
  readonly messageId: string;

  private readonly controller: MarkdownStreamController;
  private readonly finishProducer: () => void;
  private readonly streamDone: Promise<{ messageId: string }>;
  private readonly outbound: OutboundCardClient;
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private finalized = false;
  private finalizePromise: Promise<void> | undefined;
  private updateTail: Promise<void> = Promise.resolve();
  private state: RenderState = { textBuffer: "", currentRawMsgId: null };

  constructor(opts: {
    controller: MarkdownStreamController;
    finishProducer: () => void;
    streamDone: Promise<{ messageId: string }>;
    outbound: OutboundCardClient;
    startedAtMs: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  }) {
    this.messageId = opts.controller.messageId;
    this.controller = opts.controller;
    this.finishProducer = opts.finishProducer;
    this.streamDone = opts.streamDone;
    this.outbound = opts.outbound;
    this.startedAtMs = opts.startedAtMs;
    this.now = opts.now;
    this.sleep = opts.sleep;
  }

  handle(event: AgentStreamEvent): void {
    if (this.finalized) return;
    if (event.type === "text_delta") {
      this.accumulateText(event);
      this.queueLiveUpdate(liveMarkdown(this.state.textBuffer));
      return;
    }
    // A compact, non-sensitive status is useful before the first answer token.
    // Once text exists, tool activity stays out of the answer card.
    if (event.type === "tool_use" && !this.state.textBuffer) {
      this.queueLiveUpdate(liveMarkdown("", progressText(event.toolName)));
    }
  }

  finalize(opts: {
    finalText?: string;
    success: boolean;
    failureReason?: string;
    interrupted?: boolean;
  }): Promise<void> {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalized = true;
    this.finalizePromise = this.finish(opts);
    return this.finalizePromise;
  }

  private accumulateText(event: Extract<AgentStreamEvent, { type: "text_delta" }>): void {
    const rawMsgId = extractRawMessageId(event.raw);
    if (rawMsgId !== null && rawMsgId !== this.state.currentRawMsgId) {
      if (this.state.textBuffer.length > 0) this.state.textBuffer += "\n\n";
      this.state.currentRawMsgId = rawMsgId;
      this.state.textBuffer += event.text;
      return;
    }

    if (this.state.currentRawMsgId === null) this.state.currentRawMsgId = rawMsgId;
    const lastSeparator = this.state.textBuffer.lastIndexOf("\n\n");
    const currentTurnStart = lastSeparator === -1 ? 0 : lastSeparator + 2;
    this.state.textBuffer = this.state.textBuffer.slice(0, currentTurnStart) + event.text;
  }

  private queueLiveUpdate(content: string): void {
    if (!content) return;
    this.updateTail = this.updateTail
      .catch(() => undefined)
      .then(() => this.controller.setContent(content));
    void this.updateTail.catch((err) => console.error("[card] native stream update failed:", err));
  }

  private async finish(opts: {
    finalText?: string;
    success: boolean;
    interrupted?: boolean;
  }): Promise<void> {
    const content = terminalMarkdown({
      bodyText: opts.finalText ?? this.state.textBuffer,
      success: opts.success,
      interrupted: opts.interrupted,
      elapsedMs: Math.max(0, this.now() - this.startedAtMs),
    });

    let nativeStreamError: unknown;
    try {
      await this.updateTail.catch(() => undefined);
      await this.controller.setContent(content);
    } catch (err) {
      nativeStreamError = err;
    } finally {
      // The SDK finalizes CardKit only after the producer settles.
      this.finishProducer();
    }

    try {
      await this.streamDone;
    } catch (err) {
      nativeStreamError ??= err;
    }

    // @larksuite/channel's native markdown stream intentionally swallows
    // element-update/final-settings failures. One transient update also marks
    // that stream failed and suppresses every later snapshot. Therefore a
    // resolved stream promise alone is not proof that the final answer reached
    // the card. The transport force-updates the exact CardKit entity referenced
    // by this message (and only falls back to message patching for legacy cards).
    try {
      if (content.length <= STATIC_FINAL_CARD_MAX_CHARS) {
        await this.replaceFinalCardWithRetry(content);
      }
      let verified = await this.verifyFinalMarkdown(content);
      // A successful CardKit update can become visible slightly before the
      // message-read API returns the new raw card. If the first verification
      // window misses it, refresh the SAME message once more; never create a
      // second reply merely because readback lagged.
      if (!verified && content.length <= STATIC_FINAL_CARD_MAX_CHARS) {
        console.warn(
          `[card] final card readback lagged; refreshing original message_id=${this.messageId}`,
        );
        await this.replaceFinalCardWithRetry(content);
        verified = await this.verifyFinalMarkdown(content);
      }
      if (!verified) {
        throw new Error(`final card readback did not match message_id=${this.messageId}`);
      }
      if (nativeStreamError !== undefined) {
        console.warn(
          `[card] native stream finalization failed but static final card recovered message_id=${this.messageId}: ${conciseError(nativeStreamError)}`,
        );
      }
      console.log(`[card] final card verified message_id=${this.messageId}`);
      return;
    } catch (replaceErr) {
      console.error(
        `[card] final card commit not confirmed message_id=${this.messageId}: ${conciseError(replaceErr)}`,
      );
      throw new AggregateError(
        [nativeStreamError, replaceErr].filter((err) => err !== undefined),
        `card finalization failed for original message ${this.messageId}`,
      );
    } finally {
      this.outbound.releaseCard?.(this.messageId);
    }
  }

  private async replaceFinalCardWithRetry(content: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= FINAL_REPLACE_ATTEMPTS; attempt++) {
      try {
        await this.outbound.replaceCard(this.messageId, staticFinalCard(content));
        return;
      } catch (err) {
        lastError = err;
        if (attempt === FINAL_REPLACE_ATTEMPTS) break;
        const delayMs = FINAL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(
          `[card] final card update attempt ${attempt} failed message_id=${this.messageId}; retrying in ${delayMs}ms: ${conciseError(err)}`,
        );
        await this.sleep(delayMs);
      }
    }
    throw lastError;
  }

  private async verifyFinalMarkdown(content: string): Promise<boolean> {
    // Feishu may normalize the stored Markdown around quotes/blank lines, so
    // byte-for-byte equality creates false negatives. The first line is the
    // unambiguous success/failure/interruption marker and is also present on the
    // head card when a long stream rolls over.
    const expected = content.split("\n", 1)[0]?.trim() ?? "";
    for (let attempt = 1; attempt <= FINAL_VERIFY_ATTEMPTS; attempt++) {
      try {
        const actual = (await this.outbound.readCardMarkdown(this.messageId))?.trim();
        if (actual?.includes(expected)) return true;
      } catch (err) {
        if (attempt === FINAL_VERIFY_ATTEMPTS) {
          console.warn(
            `[card] final card readback failed message_id=${this.messageId}: ${conciseError(err)}`,
          );
          return false;
        }
      }
      if (attempt < FINAL_VERIFY_ATTEMPTS) await this.sleep(FINAL_RETRY_BASE_DELAY_MS * attempt);
    }
    return false;
  }
}

export class CardRenderer {
  private readonly outbound: OutboundCardClient;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: CardRendererOptions) {
    this.outbound = opts.outbound;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? sleep;
  }

  async start(
    chatId: string,
    replyToMessageId: string,
    opts?: { replyInThread?: boolean; startedAtMs?: number },
  ): Promise<CardHandle> {
    let finishProducer!: () => void;
    const producerLifetime = new Promise<void>((resolve) => {
      finishProducer = resolve;
    });

    let markReady!: (controller: MarkdownStreamController) => void;
    let markStartFailed!: (error: unknown) => void;
    const ready = new Promise<MarkdownStreamController>((resolve, reject) => {
      markReady = resolve;
      markStartFailed = reject;
    });

    const streamDone = this.outbound.streamMarkdown(
      chatId,
      replyToMessageId,
      { replyInThread: opts?.replyInThread ?? true },
      async (controller) => {
        markReady(controller);
        await producerLifetime;
      },
    );
    // If CardKit creation fails, start() must fail instead of waiting forever.
    void streamDone.catch(markStartFailed);

    const controller = await ready;
    // CardKit already receives this text in the initial card spec. Push it once
    // more through the element-content API so clients that defer rendering a
    // referenced streaming card show the status before the first agent token.
    try {
      await controller.setContent(INITIAL_STREAM_TEXT);
    } catch (err) {
      finishProducer();
      await streamDone.catch(() => undefined);
      this.outbound.releaseCard?.(controller.messageId);
      throw err;
    }
    return new CardHandleImpl({
      controller,
      finishProducer,
      streamDone,
      outbound: this.outbound,
      startedAtMs: opts?.startedAtMs ?? this.now(),
      now: this.now,
      sleep: this.sleep,
    });
  }
}

// Test-only exports also document the terminal markers consumed by history recovery.
export {
  FAILURE_MARKER as _FAILURE_MARKER,
  INTERRUPTED_MARKER as _INTERRUPTED_MARKER,
  liveMarkdown as _liveMarkdown,
  formatDuration as _formatDuration,
  optimizeMarkdownStyle as _optimizeMarkdownStyle,
  terminalMarkdown as _terminalMarkdown,
};
