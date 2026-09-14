/**
 * Renders one agent turn through a managed CardKit stream. Tool activity and
 * answer text use separate elements so mutable status never invalidates the
 * answer element's append-only typewriter buffer.
 */

import type { AgentStreamEvent } from "../claude/runner.js";
import { BODY_ELEMENT_ID, STATUS_ELEMENT_ID } from "./cardStream.js";

export interface MarkdownStreamController {
  readonly messageId: string;
  setStatus(fullContent: string): Promise<void>;
  setContent(fullContent: string): Promise<void>;
  /** Authoritative final text; transport commits and verifies every segment. */
  setFinalContent?(status: string, body: string): void;
}

export interface OutboundCardClient {
  streamMarkdown(
    chatId: string,
    replyToMessageId: string,
    opts: { replyInThread: boolean; initialStatus: string },
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
  setPhase?(phase: string): void;
  /** Finish the managed stream and wait until CardKit has committed the final content. */
  finalize(opts: {
    finalText?: string;
    success: boolean;
    failureReason?: string;
    interrupted?: boolean;
    interruptionReason?: "shutdown" | "resolved";
    timedOut?: boolean;
  }): Promise<void>;
}

const FAILURE_MARKER = "**处理失败**";
const INTERRUPTED_MARKER = "**已被新消息打断**";
const PROCESSING_STATUS = "> ⏳ **正在处理**";
const SUCCESS_STATUS = "> ✅ **回复完成**";
export const INITIAL_STREAM_TEXT = `${PROCESSING_STATUS}\n> Agent 正在思考或执行任务...`;
const STATIC_FINAL_CARD_MAX_CHARS = 29_000;
const LIVE_UPDATE_THROTTLE_MS = 100;
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

function staticFinalCard(status: string, body: string): object {
  const markdown = body ? `${status}\n\n${body}` : status;
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      summary: { content: truncateSummary(markdown) },
    },
    body: {
      elements: [
        { tag: "markdown", element_id: STATUS_ELEMENT_ID, content: status },
        { tag: "markdown", element_id: BODY_ELEMENT_ID, content: body || "\u200b" },
      ],
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

function toolDisplayName(toolName: string): string {
  const searchable = toolName.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  if (/\b(?:web search|websearch|search query)\b/.test(searchable)) return "网页搜索";
  if (/\b(?:read|search|find|fetch|open)\b/.test(searchable)) return "查找资料";
  if (/\b(?:write|edit|patch|file change)\b/.test(searchable)) return "修改文件";
  if (/\b(?:bash|exec|command|shell|test)\b/.test(searchable)) return "执行命令";

  const cleaned = toolName
    .replace(/^mcp__/, "")
    .replace(/__/g, ".")
    .replace(/_+/g, " ")
    .replace(/[*_`[\]<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateSummary(cleaned || "工具", 32);
}

interface ToolActivitySnapshot {
  startedCount: number;
  completedCount: number;
  activeNames: string[];
}

function summarizeActiveTools(toolNames: string[]): string {
  const counts = new Map<string, number>();
  for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  const entries = [...counts.entries()];
  const visible = entries.slice(0, 2).map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const hiddenCount = entries.slice(2).reduce((sum, [, count]) => sum + count, 0);
  return hiddenCount > 0 ? `${visible.join("、")}，另有 ${hiddenCount} 个` : visible.join("、");
}

function renderActivity(activity: ToolActivitySnapshot): string[] {
  if (activity.startedCount === 0) return [];
  const activeCount = activity.activeNames.length;
  const lines = [
    `> 🔧 已调用 ${activity.startedCount} 次 · 已完成 ${activity.completedCount} 次 · 进行中 ${activeCount}`,
  ];
  lines.push(
    activeCount > 0
      ? `> 正在调用：${summarizeActiveTools(activity.activeNames)}`
      : "> 正在整理结果...",
  );
  return lines;
}

function liveStatusMarkdown(activity?: ToolActivitySnapshot): string {
  const activityLines = activity ? renderActivity(activity) : [];
  return activityLines.length > 0
    ? [PROCESSING_STATUS, ...activityLines].join("\n")
    : INITIAL_STREAM_TEXT;
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

interface TerminalContent {
  status: string;
  body: string;
  markdown: string;
}

function terminalContent(opts: {
  bodyText: string;
  success: boolean;
  interrupted?: boolean;
  elapsedMs: number;
  toolCount?: number;
  interruptionReason?: "shutdown" | "resolved";
  timedOut?: boolean;
}): TerminalContent {
  const body = optimizeMarkdownStyle(opts.bodyText);
  const duration = `> ⏱️ 处理耗时：${formatDuration(opts.elapsedMs)}`;
  const toolSummary = opts.toolCount ? `\n> 🔧 共调用 ${opts.toolCount} 次工具` : "";
  let status: string;
  let finalBody = body;
  if (opts.interrupted && opts.interruptionReason) {
    status = `> ⏸️ **处理已中断**${toolSummary}\n${duration}\n> ${opts.interruptionReason === "shutdown" ? "服务正在停止，请重新 @ 我继续。" : "本话题已结束。"}`;
  } else if (opts.interrupted) {
    status = `> ⏸️ ${INTERRUPTED_MARKER}${toolSummary}\n${duration}\n> 正在按新消息继续处理。`;
  } else if (!opts.success) {
    status = `> ❌ ${FAILURE_MARKER}${toolSummary}\n${duration}\n> ${opts.timedOut ? "本轮处理超时，请缩小任务范围后重试。" : "请稍后重试，详细原因已写入服务日志。"}`;
  } else {
    status = `${SUCCESS_STATUS}${toolSummary}\n${duration}`;
    finalBody ||= "本轮没有拿到 agent 的回复，请再 @ 我一次重试。";
  }
  return {
    status,
    body: finalBody,
    markdown: finalBody ? `${status}\n\n${finalBody}` : status,
  };
}

function terminalMarkdown(opts: Parameters<typeof terminalContent>[0]): string {
  return terminalContent(opts).markdown;
}

interface RenderState {
  textBuffer: string;
  /** Raw message id of the currently accumulating assistant turn. */
  currentRawMsgId: string | null;
  currentTurnStart: number;
  toolCallCount: number;
  completedToolCount: number;
  anonymousCallSequence: number;
  startedCallIds: Set<string>;
  finishedCallIds: Set<string>;
  activeTools: Map<string, string>;
}

function createRenderState(): RenderState {
  return {
    textBuffer: "",
    currentRawMsgId: null,
    currentTurnStart: 0,
    toolCallCount: 0,
    completedToolCount: 0,
    anonymousCallSequence: 0,
    startedCallIds: new Set(),
    finishedCallIds: new Set(),
    activeTools: new Map(),
  };
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
  private pendingLiveStatus: string | undefined;
  private pendingLiveBody: string | undefined;
  private drainingLiveUpdates = false;
  private lastLiveUpdateAtMs: number | undefined;
  private state: RenderState = createRenderState();
  private phase = "Agent 正在思考或执行任务";
  private lastActivityAtMs: number | undefined;
  private readonly heartbeat: ReturnType<typeof setInterval>;

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
    this.heartbeat = setInterval(() => this.queueStatusSnapshot(true), 15_000);
    this.heartbeat.unref();
  }

  setPhase(phase: string): void {
    this.phase = phase;
    this.queueStatusSnapshot(true);
  }

  handle(event: AgentStreamEvent): void {
    if (this.finalized) return;
    this.lastActivityAtMs = this.now();
    if (event.type === "text_delta") {
      this.accumulateText(event);
      this.queueBodySnapshot();
      return;
    }
    if (event.type === "tool_started") {
      if (this.startTool(event.callId, event.toolName)) this.queueStatusSnapshot();
      return;
    }
    if (event.type === "tool_finished" && this.finishTool(event.callId)) this.queueStatusSnapshot();
  }

  finalize(opts: {
    finalText?: string;
    success: boolean;
    failureReason?: string;
    interrupted?: boolean;
    interruptionReason?: "shutdown" | "resolved";
    timedOut?: boolean;
  }): Promise<void> {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalized = true;
    clearInterval(this.heartbeat);
    this.finalizePromise = this.finish(opts);
    return this.finalizePromise;
  }

  private accumulateText(event: Extract<AgentStreamEvent, { type: "text_delta" }>): void {
    const rawMsgId = extractRawMessageId(event.raw);
    if (rawMsgId !== null && rawMsgId !== this.state.currentRawMsgId) {
      if (this.state.textBuffer.length > 0) this.state.textBuffer += "\n\n";
      this.state.currentTurnStart = this.state.textBuffer.length;
      this.state.currentRawMsgId = rawMsgId;
      this.state.textBuffer += event.text;
      return;
    }

    if (this.state.currentRawMsgId === null) this.state.currentRawMsgId = rawMsgId;
    this.state.textBuffer = this.state.textBuffer.slice(0, this.state.currentTurnStart) + event.text;
  }

  private startTool(callId: string | undefined, rawToolName: string): boolean {
    const callKey = callId ?? `anonymous-${++this.state.anonymousCallSequence}`;
    if (this.state.startedCallIds.has(callKey) || this.state.finishedCallIds.has(callKey)) {
      return false;
    }
    this.state.startedCallIds.add(callKey);
    this.state.activeTools.set(callKey, toolDisplayName(rawToolName));
    this.state.toolCallCount++;
    return true;
  }

  private finishTool(callId: string | undefined): boolean {
    let callKey = callId;
    if (callKey && this.state.finishedCallIds.has(callKey)) return false;

    if (!callKey) callKey = this.state.activeTools.keys().next().value as string | undefined;
    if (!callKey) callKey = `anonymous-${++this.state.anonymousCallSequence}`;
    if (this.state.finishedCallIds.has(callKey)) return false;

    // Some Codex item types only emit item.completed. Count those once so the
    // final total still reflects every observed tool call.
    if (!this.state.startedCallIds.has(callKey)) {
      this.state.startedCallIds.add(callKey);
      this.state.toolCallCount++;
    }
    this.state.finishedCallIds.add(callKey);
    this.state.activeTools.delete(callKey);
    this.state.completedToolCount++;
    return true;
  }

  private queueStatusSnapshot(showTiming = false): void {
    if (this.finalized) return;
    this.queueLiveUpdate({
      status: liveStatusMarkdown({
        startedCount: this.state.toolCallCount,
        completedCount: this.state.completedToolCount,
        activeNames: [...this.state.activeTools.values()],
      }) + (showTiming ? `\n> ${this.phase} · 已用时 ${formatDuration(this.now() - this.startedAtMs)}\n> ${this.lastActivityAtMs === undefined ? "尚未收到 Agent 输出" : `最近收到 Agent 活动：${formatDuration(this.now() - this.lastActivityAtMs)}前`}` : ""),
    });
  }

  private queueBodySnapshot(): void {
    const body = optimizeMarkdownStyle(this.state.textBuffer);
    if (body) this.queueLiveUpdate({ body });
  }

  private queueLiveUpdate(update: { status?: string; body?: string }): void {
    if (update.status !== undefined) this.pendingLiveStatus = update.status;
    if (update.body !== undefined) this.pendingLiveBody = update.body;
    if (this.drainingLiveUpdates) return;

    // Keep only the newest snapshot while a CardKit update is in flight. This
    // prevents fast/parallel events from building a visibly stale queue while
    // keeping status and append-only answer content completely independent.
    this.drainingLiveUpdates = true;
    this.updateTail = this.updateTail
      .catch(() => undefined)
      .then(async () => {
        while (this.pendingLiveStatus !== undefined || this.pendingLiveBody !== undefined) {
          const nextStatus = this.pendingLiveStatus;
          const nextBody = this.pendingLiveBody;
          this.pendingLiveStatus = undefined;
          this.pendingLiveBody = undefined;
          if (this.lastLiveUpdateAtMs !== undefined) {
            const remainingMs = LIVE_UPDATE_THROTTLE_MS - (this.now() - this.lastLiveUpdateAtMs);
            if (remainingMs > 0) await this.sleep(remainingMs);
          }
          if (nextStatus !== undefined) {
            try {
              await this.controller.setStatus(nextStatus);
            } catch (err) {
              console.error("[card] status element update failed:", err);
            }
          }
          if (nextBody !== undefined) {
            try {
              await this.controller.setContent(nextBody);
            } catch (err) {
              console.error("[card] answer element update failed:", err);
            }
          }
          this.lastLiveUpdateAtMs = this.now();
        }
      })
      .finally(() => {
        this.drainingLiveUpdates = false;
        // An event can land after the drain loop observes an empty queue but
        // before this finally callback runs. Re-arm the drain so that narrow
        // microtask boundary cannot strand the newest snapshot.
        if (this.pendingLiveStatus !== undefined || this.pendingLiveBody !== undefined) {
          this.queueLiveUpdate({});
        }
      });
  }

  private async flushLiveUpdates(): Promise<void> {
    while (
      this.drainingLiveUpdates
      || this.pendingLiveStatus !== undefined
      || this.pendingLiveBody !== undefined
    ) {
      const tail = this.updateTail;
      await tail.catch(() => undefined);
      if (
        tail === this.updateTail
        && !this.drainingLiveUpdates
        && this.pendingLiveStatus === undefined
        && this.pendingLiveBody === undefined
      ) {
        return;
      }
    }
  }

  private async finish(opts: {
    finalText?: string;
    success: boolean;
    interrupted?: boolean;
    interruptionReason?: "shutdown" | "resolved";
    timedOut?: boolean;
  }): Promise<void> {
    const terminal = terminalContent({
      bodyText: opts.finalText ?? this.state.textBuffer,
      success: opts.success,
      interrupted: opts.interrupted,
      elapsedMs: Math.max(0, this.now() - this.startedAtMs),
      toolCount: this.state.toolCallCount,
      interruptionReason: opts.interruptionReason,
      timedOut: opts.timedOut,
    });
    const content = terminal.markdown;

    await this.flushLiveUpdates();
    if (this.controller.setFinalContent) {
      this.controller.setFinalContent(terminal.status, terminal.body);
      this.finishProducer();
      try {
        await this.streamDone;
        console.log(`[card] all final segments verified message_id=${this.messageId}`);
      } finally {
        this.outbound.releaseCard?.(this.messageId);
      }
      return;
    }
    const terminalUpdateErrors: unknown[] = [];
    try {
      await this.controller.setStatus(terminal.status);
    } catch (err) {
      terminalUpdateErrors.push(err);
    }
    try {
      await this.controller.setContent(terminal.body);
    } catch (err) {
      terminalUpdateErrors.push(err);
    }
    let streamError: unknown = terminalUpdateErrors.length > 0
      ? new AggregateError(terminalUpdateErrors, "failed to update terminal CardKit elements")
      : undefined;

    // The channel adapter finalizes every managed CardKit segment only after
    // the producer settles.
    this.finishProducer();

    try {
      await this.streamDone;
    } catch (err) {
      streamError ??= err;
    }

    // Live element failures are logged so generation can continue, and the
    // managed stream can still fail while closing its segments. Therefore the
    // producer settling is not proof that the terminal answer reached Feishu.
    // Force-update the exact CardKit entity referenced by this message (and
    // only fall back to message patching for legacy cards), then read it back.
    try {
      if (content.length <= STATIC_FINAL_CARD_MAX_CHARS) {
        await this.replaceFinalCardWithRetry(terminal.status, terminal.body);
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
        await this.replaceFinalCardWithRetry(terminal.status, terminal.body);
        verified = await this.verifyFinalMarkdown(content);
      }
      if (!verified) {
        throw new Error(`final card readback did not match message_id=${this.messageId}`);
      }
      if (streamError !== undefined) {
        console.warn(
          `[card] managed stream finalization failed but static final card recovered message_id=${this.messageId}: ${conciseError(streamError)}`,
        );
      }
      console.log(`[card] final card verified message_id=${this.messageId}`);
      return;
    } catch (replaceErr) {
      console.error(
        `[card] final card commit not confirmed message_id=${this.messageId}: ${conciseError(replaceErr)}`,
      );
      throw new AggregateError(
        [streamError, replaceErr].filter((err) => err !== undefined),
        `card finalization failed for original message ${this.messageId}`,
      );
    } finally {
      this.outbound.releaseCard?.(this.messageId);
    }
  }

  private async replaceFinalCardWithRetry(status: string, body: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= FINAL_REPLACE_ATTEMPTS; attempt++) {
      try {
        await this.outbound.replaceCard(this.messageId, staticFinalCard(status, body));
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
      { replyInThread: opts?.replyInThread ?? true, initialStatus: INITIAL_STREAM_TEXT },
      async (controller) => {
        markReady(controller);
        await producerLifetime;
      },
    );
    // If CardKit creation fails, start() must fail instead of waiting forever.
    void streamDone.catch(markStartFailed);

    const controller = await ready;
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
  liveStatusMarkdown as _liveStatusMarkdown,
  formatDuration as _formatDuration,
  optimizeMarkdownStyle as _optimizeMarkdownStyle,
  terminalMarkdown as _terminalMarkdown,
};
