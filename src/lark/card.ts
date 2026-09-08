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
}

export interface CardRendererOptions {
  outbound: OutboundCardClient;
  /** Injectable clock for deterministic duration rendering in tests. */
  now?: () => number;
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
  private readonly startedAtMs: number;
  private readonly now: () => number;
  private finalized = false;
  private finalizePromise: Promise<void> | undefined;
  private updateTail: Promise<void> = Promise.resolve();
  private state: RenderState = { textBuffer: "", currentRawMsgId: null };

  constructor(opts: {
    controller: MarkdownStreamController;
    finishProducer: () => void;
    streamDone: Promise<{ messageId: string }>;
    startedAtMs: number;
    now: () => number;
  }) {
    this.messageId = opts.controller.messageId;
    this.controller = opts.controller;
    this.finishProducer = opts.finishProducer;
    this.streamDone = opts.streamDone;
    this.startedAtMs = opts.startedAtMs;
    this.now = opts.now;
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

    let finalUpdateError: unknown;
    try {
      await this.updateTail.catch(() => undefined);
      await this.controller.setContent(content);
    } catch (err) {
      finalUpdateError = err;
    } finally {
      // The SDK finalizes CardKit only after the producer settles.
      this.finishProducer();
    }

    await this.streamDone;
    if (finalUpdateError) throw finalUpdateError;
  }
}

export class CardRenderer {
  private readonly outbound: OutboundCardClient;
  private readonly now: () => number;

  constructor(opts: CardRendererOptions) {
    this.outbound = opts.outbound;
    this.now = opts.now ?? Date.now;
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
      throw err;
    }
    return new CardHandleImpl({
      controller,
      finishProducer,
      streamDone,
      startedAtMs: opts?.startedAtMs ?? this.now(),
      now: this.now,
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
