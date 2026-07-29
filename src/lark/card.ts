/**
 * src/lark/card.ts
 *
 * Maintains the render state of a Feishu interactive card for a single Claude
 * stream-json session: accumulates stream events, throttle-PATCHes the card,
 * and writes the final state on finalize(). A chat reply is just text.
 *
 * Constraints:
 *  - handle()/live PATCH never throw (errors logged + retried)
 *  - finalize() may throw so the caller (handler.ts) can surface it
 */

import type { AgentStreamEvent } from "../claude/runner.js";

// ---------------------------------------------------------------------------
// Outbound transport (implemented by channel.ts)
// ---------------------------------------------------------------------------

export interface OutboundCardClient {
  /** Create the initial card by replying to the user's message. */
  createCard(
    replyToMessageId: string,
    cardJson: string,
    opts: { replyInThread: boolean },
  ): Promise<{ messageId: string }>;
  /** Update an existing card's content. */
  patchCard(messageId: string, cardJson: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CardRendererOptions {
  /** Throttle interval (ms) between live PATCH calls. @default 1000 */
  patchIntervalMs?: number;
  /** Show tool-use summary lines while streaming. @default true */
  showToolUseSummary?: boolean;
  /** Outbound transport (required). */
  outbound: OutboundCardClient;
}

export interface CardHandle {
  /** message_id of the created card — used for subsequent PATCHes. */
  messageId: string;
  /** Accumulate a stream event and throttle-PATCH. Never throws. */
  handle(event: AgentStreamEvent): void;
  /** Write the final card state. May throw if the final PATCH fails. */
  finalize(opts: {
    finalText?: string;
    success: boolean;
    failureReason?: string;
    /** true → render the neutral "⏸️ 已被新消息打断" state instead of success/failure. */
    interrupted?: boolean;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Truncate a tool input to a short one-line summary (≤ 60 chars). */
function summarizeInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  let s: string;
  if (typeof input === "string") {
    s = input;
  } else if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const snippet =
      obj["command"] ?? obj["path"] ?? obj["file_path"] ?? obj["description"] ?? null;
    s = snippet != null ? String(snippet) : JSON.stringify(input);
  } else {
    s = String(input);
  }
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

/**
 * Strip leaked tool-call markup so the operator never sees raw
 * `<invoke …>` / `<parameter …>` XML when the model mis-emits a tool call as text.
 */
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
 * Split markdown into ≤ maxLen chunks to respect Feishu's ~3000-char markdown
 * element limit (conservative 2800 budget for multi-byte / surrounding markup).
 */
function chunkMarkdown(text: string, maxLen = 2800): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (line.length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += maxLen) chunks.push(line.slice(i, i + maxLen));
      continue;
    }
    const appended = current ? current + "\n" + line : line;
    if (appended.length > maxLen) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = appended;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

type CardStatus = "thinking" | "streaming" | "success" | "failure" | "interrupted";

/** Build a Feishu Card JSON 2.0 string. */
function buildCardJson(opts: {
  bodyText: string;
  toolLines: string[];
  showToolSummary: boolean;
  status: CardStatus;
  failureReason?: string;
  /** Hide the tool-use timeline (set on successful finalize — process is over). */
  hideTools?: boolean;
}): string {
  const elements: unknown[] = [];

  // Tool-use summary (capped, hidden on success).
  const TOOL_LINES_CAP = 5;
  if (
    opts.showToolSummary &&
    opts.toolLines.length > 0 &&
    !opts.hideTools &&
    opts.status !== "success"
  ) {
    const recent = opts.toolLines.slice(-TOOL_LINES_CAP);
    const omitted = opts.toolLines.length - recent.length;
    const content =
      omitted > 0 ? `_(略前 ${omitted} 条工具调用)_\n${recent.join("\n")}` : recent.join("\n");
    elements.push({ tag: "markdown", content });
    elements.push({ tag: "hr" });
  }

  // Main body text.
  const cleanBody = opts.bodyText ? stripLeakedToolMarkup(opts.bodyText) : "";
  if (cleanBody) {
    const chunks = chunkMarkdown(cleanBody);
    for (let i = 0; i < chunks.length; i++) {
      elements.push({
        tag: "markdown",
        content: i === 0 ? chunks[i] : `(续 ${i + 1})\n${chunks[i]}`,
      });
    }
  } else if (opts.status === "thinking") {
    elements.push({ tag: "markdown", content: "🤔 思考中…" });
  }

  // Failure reason.
  if (opts.status === "failure" && opts.failureReason) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: `⚠️ **错误**: ${opts.failureReason}` });
  }

  // Interrupted note (new message arrived mid-processing).
  if (opts.status === "interrupted") {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: "⏸️ 已被新消息打断,正在按新消息继续…" });
  }

  const headerColor =
    opts.status === "thinking" || opts.status === "streaming"
      ? "blue"
      : opts.status === "success"
        ? "green"
        : opts.status === "interrupted"
          ? "grey"
          : "red";
  const headerTitle =
    opts.status === "thinking"
      ? "⏳ 处理中"
      : opts.status === "streaming"
        ? "🔧 处理中"
        : opts.status === "success"
          ? "✅ 完成"
          : opts.status === "interrupted"
            ? "⏸️ 已被新消息打断"
            : "❌ 出错了";

  const card = {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: headerTitle }, template: headerColor },
    body: { elements },
  };
  return JSON.stringify(card);
}

// ---------------------------------------------------------------------------
// Per-card render state
// ---------------------------------------------------------------------------

interface RenderState {
  textBuffer: string;
  /** raw message_id of the currently-accumulating assistant turn. */
  currentRawMsgId: string | null;
  toolStatusLines: string[];
  lastPatchAt: number;
  pendingPatch: ReturnType<typeof setTimeout> | null;
}

/** Extract the message-level id from a raw assistant event (best-effort). */
function extractRawMessageId(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const msg = (raw as Record<string, unknown>)["message"];
  if (typeof msg !== "object" || msg === null) return null;
  const id = (msg as Record<string, unknown>)["id"];
  if (typeof id === "string") return id;
  const item = (raw as Record<string, unknown>)["item"];
  if (typeof item !== "object" || item === null) return null;
  const itemId = (item as Record<string, unknown>)["id"];
  return typeof itemId === "string" ? itemId : null;
}

// ---------------------------------------------------------------------------
// CardHandle implementation
// ---------------------------------------------------------------------------

class CardHandleImpl implements CardHandle {
  readonly messageId: string;
  private readonly outbound: OutboundCardClient;
  private readonly patchIntervalMs: number;
  private readonly showToolSummary: boolean;
  private finalized = false;

  private state: RenderState = {
    textBuffer: "",
    currentRawMsgId: null,
    toolStatusLines: [],
    lastPatchAt: 0,
    pendingPatch: null,
  };

  constructor(opts: {
    messageId: string;
    outbound: OutboundCardClient;
    patchIntervalMs: number;
    showToolSummary: boolean;
  }) {
    this.messageId = opts.messageId;
    this.outbound = opts.outbound;
    this.patchIntervalMs = opts.patchIntervalMs;
    this.showToolSummary = opts.showToolSummary;
  }

  handle(event: AgentStreamEvent): void {
    if (this.finalized) return;
    this.accumulate(event);
    this.scheduleThrottledPatch();
  }

  async finalize(opts: {
    finalText?: string;
    success: boolean;
    failureReason?: string;
    interrupted?: boolean;
  }): Promise<void> {
    this.finalized = true;
    if (this.state.pendingPatch !== null) {
      clearTimeout(this.state.pendingPatch);
      this.state.pendingPatch = null;
    }
    const bodyText = opts.finalText ?? this.state.textBuffer;
    const status: CardStatus = opts.interrupted ? "interrupted" : opts.success ? "success" : "failure";
    const cardJson = buildCardJson({
      bodyText,
      toolLines: this.state.toolStatusLines,
      showToolSummary: this.showToolSummary,
      status,
      failureReason: opts.failureReason,
      hideTools: opts.success,
    });
    await this.patchWithRetry(cardJson, /* throwOnFinalFail */ true);
  }

  // ── accumulate ────────────────────────────────────────────────────────────

  private accumulate(event: AgentStreamEvent): void {
    if (event.type === "text_delta") {
      // `--include-partial-messages` → each event carries the FULL text of the
      // current assistant turn (a snapshot). Across turns (different raw msg id)
      // we append with a separator; within a turn we replace.
      const rawMsgId = extractRawMessageId(event.raw);
      if (rawMsgId !== null && rawMsgId !== this.state.currentRawMsgId) {
        if (this.state.textBuffer.length > 0) this.state.textBuffer += "\n\n";
        this.state.currentRawMsgId = rawMsgId;
        this.state.textBuffer += event.text;
      } else {
        if (this.state.currentRawMsgId === null) this.state.currentRawMsgId = rawMsgId;
        const prevTurnEnd = this.findPrevTurnEnd();
        this.state.textBuffer = this.state.textBuffer.slice(0, prevTurnEnd) + event.text;
      }
    } else if (event.type === "tool_use" && this.showToolSummary) {
      const summary = summarizeInput(event.toolInput);
      this.state.toolStatusLines.push(summary ? `🔧 ${event.toolName} ${summary}` : `🔧 ${event.toolName}`);
    }
  }

  private findPrevTurnEnd(): number {
    if (!this.state.textBuffer) return 0;
    const lastSep = this.state.textBuffer.lastIndexOf("\n\n");
    return lastSep === -1 ? 0 : lastSep + 2;
  }

  // ── throttle ────────────────────────────────────────────────────────────

  private scheduleThrottledPatch(): void {
    const elapsed = Date.now() - this.state.lastPatchAt;
    if (elapsed >= this.patchIntervalMs) {
      void this.doLivePatch();
    } else if (this.state.pendingPatch === null) {
      this.state.pendingPatch = setTimeout(() => {
        this.state.pendingPatch = null;
        if (!this.finalized) void this.doLivePatch();
      }, this.patchIntervalMs - elapsed);
      this.state.pendingPatch.unref();
    }
  }

  private async doLivePatch(): Promise<void> {
    this.state.lastPatchAt = Date.now();
    const cardJson = buildCardJson({
      bodyText: this.state.textBuffer,
      toolLines: this.state.toolStatusLines,
      showToolSummary: this.showToolSummary,
      status: this.state.textBuffer ? "streaming" : "thinking",
    });
    await this.patchWithRetry(cardJson);
  }

  /** PATCH with exponential backoff (500ms, 1000ms). Live patches swallow; finalize re-throws. */
  private async patchWithRetry(cardJson: string, throwOnFinalFail = false, maxAttempts = 3): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.outbound.patchCard(this.messageId, cardJson);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts) {
          console.error(`[card] PATCH failed after ${attempt} attempts:`, err);
          if (throwOnFinalFail) throw err;
          return;
        }
        const delay = 500 * Math.pow(2, attempt - 1);
        console.warn(`[card] PATCH attempt ${attempt} failed, retrying in ${delay}ms:`, (err as Error).message);
        await new Promise<void>((r) => setTimeout(r, delay));
      }
    }
    if (throwOnFinalFail && lastErr) throw lastErr;
  }
}

// ---------------------------------------------------------------------------
// CardRenderer
// ---------------------------------------------------------------------------

export class CardRenderer {
  private readonly outbound: OutboundCardClient;
  private readonly patchIntervalMs: number;
  private readonly showToolSummary: boolean;

  constructor(opts: CardRendererOptions) {
    this.outbound = opts.outbound;
    this.patchIntervalMs = opts.patchIntervalMs ?? 1000;
    this.showToolSummary = opts.showToolUseSummary ?? true;
  }

  /**
   * Create the initial "thinking" card by replying to the user's message.
   * @param opts.replyInThread  true → anchor as a new topic thread (top-level @);
   *   false → a plain in-thread reply. Defaults to true.
   */
  async start(replyToMessageId: string, opts?: { replyInThread?: boolean }): Promise<CardHandle> {
    const initial = buildCardJson({ bodyText: "", toolLines: [], showToolSummary: false, status: "thinking" });
    const { messageId } = await this.outbound.createCard(replyToMessageId, initial, {
      replyInThread: opts?.replyInThread ?? true,
    });
    return new CardHandleImpl({
      messageId,
      outbound: this.outbound,
      patchIntervalMs: this.patchIntervalMs,
      showToolSummary: this.showToolSummary,
    });
  }
}

// Re-export for unit tests (not part of the public API contract).
export { buildCardJson as _buildCardJson };
