import type { MarkdownStreamController } from "./card.js";

export const STATUS_ELEMENT_ID = "status_md";
export const BODY_ELEMENT_ID = "stream_md";

const BODY_STREAM_PREFIX = "\u200b";
const BODY_CHUNK_MAX_CHARS = 29_000;

export interface ManagedCardTransport {
  createCard(card: object): Promise<{ cardId: string }>;
  sendCard(
    chatId: string,
    cardId: string,
    replyToMessageId: string,
    replyInThread: boolean,
  ): Promise<{ messageId: string }>;
  updateElement(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void>;
  updateCard(cardId: string, card: object, sequence: number): Promise<void>;
  saveFinal?(plans: Array<{ cardId: string; card: object }>): Promise<void>;
  saveFinalContent?(status: string, body: string): Promise<void>;
  verifyCard?(messageId: string, card: object): Promise<boolean>;
}

interface CardSegment {
  cardId: string;
  messageId: string;
  sequence: number;
  bodyContent: string;
  streaming: boolean;
}

function truncateSummary(text: string, max = 50): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

export function managedCardSpec(status: string, body: string, streaming: boolean): object {
  return {
    schema: "2.0",
    config: {
      streaming_mode: streaming,
      summary: { content: truncateSummary(`${status} ${body.replace(BODY_STREAM_PREFIX, "")}`) },
      ...(streaming
        ? {
            streaming_config: {
              print_frequency_ms: { default: 70 },
              print_step: { default: 1 },
              print_strategy: "fast",
            },
          }
        : {}),
    },
    body: {
      elements: [
        { tag: "markdown", element_id: STATUS_ELEMENT_ID, content: status },
        { tag: "markdown", element_id: BODY_ELEMENT_ID, content: body },
      ],
    },
  };
}

/**
 * Split a long Markdown element using the same policy as the Channel SDK:
 * prefer line boundaries, keep fenced code valid across cards, and retain
 * headroom below Feishu's 30,000-character per-element limit.
 */
export function splitManagedMarkdown(text: string, limit = BODY_CHUNK_MAX_CHARS): string[] {
  if (text.length <= limit) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let buffer: string[] = [];
  let bufferLength = 0;
  let fenceLanguage: string | null = null;

  const flush = (): void => {
    if (buffer.length === 0) return;
    let chunk = buffer.join("\n");
    if (fenceLanguage !== null) chunk += "\n```";
    chunks.push(chunk);
    buffer = [];
    bufferLength = 0;
    if (fenceLanguage !== null) {
      buffer.push(`\`\`\`${fenceLanguage}`);
      bufferLength = buffer[0]?.length ?? 0;
    }
  };

  for (const line of lines) {
    const fence = line.match(/^```(\w*)$/);
    const lineLength = line.length + (buffer.length > 0 ? 1 : 0);
    const nearFull = bufferLength > limit * 0.75;
    if (
      buffer.length > 0 &&
      (bufferLength + lineLength > limit || (/^#{1,6}\s/.test(line) && nearFull))
    ) {
      flush();
    }

    if (line.length > limit) {
      flush();
      for (let offset = 0; offset < line.length; offset += limit) {
        chunks.push(line.slice(offset, offset + limit));
      }
      continue;
    }

    buffer.push(line);
    bufferLength += lineLength;
    if (fence) fenceLanguage = fenceLanguage === null ? fence[1] || "" : null;
  }
  flush();
  return chunks;
}

/**
 * A two-element CardKit stream. Mutable tool activity is isolated in
 * `status_md`; `stream_md` receives only monotonically growing answer text, so
 * status refreshes can never restart Feishu's typewriter animation.
 */
export class ManagedMarkdownStream implements MarkdownStreamController {
  static async start(opts: {
    transport: ManagedCardTransport;
    chatId: string;
    replyToMessageId: string;
    replyInThread: boolean;
    initialStatus: string;
  }): Promise<ManagedMarkdownStream> {
    const bodyContent = BODY_STREAM_PREFIX;
    const created = await opts.transport.createCard(
      managedCardSpec(opts.initialStatus, bodyContent, true),
    );
    const sent = await opts.transport.sendCard(
      opts.chatId,
      created.cardId,
      opts.replyToMessageId,
      opts.replyInThread,
    );
    return new ManagedMarkdownStream(
      opts.transport,
      opts.chatId,
      opts.replyToMessageId,
      opts.replyInThread,
      opts.initialStatus,
      {
        cardId: created.cardId,
        messageId: sent.messageId,
        sequence: 0,
        bodyContent,
        streaming: true,
      },
    );
  }

  readonly messageId: string;

  private readonly segments: CardSegment[];
  private statusContent: string;
  private fullBody = "";
  private finalContent: { status: string; body: string } | undefined;
  private deliveryUncertain = false;

  private constructor(
    private readonly transport: ManagedCardTransport,
    private readonly chatId: string,
    private readonly replyToMessageId: string,
    private readonly replyInThread: boolean,
    initialStatus: string,
    firstSegment: CardSegment,
  ) {
    this.messageId = firstSegment.messageId;
    this.statusContent = initialStatus;
    this.segments = [firstSegment];
  }

  async setStatus(fullContent: string): Promise<void> {
    if (!fullContent || fullContent === this.statusContent) return;
    // Retain the newest intended status even when the live element update
    // fails; complete() can still recover it with a whole-card update.
    this.statusContent = fullContent;
    const active = this.activeSegment();
    await this.transport.updateElement(
      active.cardId,
      STATUS_ELEMENT_ID,
      fullContent,
      this.nextSequence(active),
    );
  }

  async setContent(fullContent: string): Promise<void> {
    if (this.deliveryUncertain) return;
    const nextBody = fullContent ?? "";
    if (nextBody === this.fullBody) return;

    // Live output must never rewind. A rare model-side revision is deferred to
    // the authoritative non-streaming final-card replacement.
    if (!nextBody.startsWith(this.fullBody)) return;

    // Live boundaries must be stable as a paragraph grows. Re-splitting at
    // newlines would move already-rendered text into the next card.
    const source = `${BODY_STREAM_PREFIX}${nextBody}`;
    const chunks: string[] = [];
    for (let offset = 0; offset < source.length; offset += BODY_CHUNK_MAX_CHARS) {
      chunks.push(source.slice(offset, offset + BODY_CHUNK_MAX_CHARS));
    }
    const activeIndex = this.segments.length - 1;
    const active = this.segments[activeIndex];
    if (!active) throw new Error("managed CardKit stream has no active segment");

    for (let index = 0; index < activeIndex; index++) {
      if (chunks[index] !== this.segments[index]?.bodyContent) {
        throw new Error("managed CardKit stream rewound across a finalized segment");
      }
    }

    if (chunks.length === this.segments.length) {
      const nextChunk = chunks[activeIndex];
      if (nextChunk !== undefined && nextChunk !== active.bodyContent) {
        await this.updateBody(active, nextChunk);
      }
      this.fullBody = nextBody;
      return;
    }

    if (chunks.length < this.segments.length) {
      throw new Error("managed CardKit stream cannot remove continuation cards");
    }

    const completedActiveBody = chunks[activeIndex];
    if (completedActiveBody === undefined) {
      throw new Error("managed CardKit stream produced an empty active chunk");
    }
    if (!completedActiveBody.startsWith(active.bodyContent)) {
      throw new Error("managed CardKit stream produced a non-monotonic rollover head");
    }
    active.bodyContent = completedActiveBody;
    await this.updateWholeCard(active, false);

    for (let index = this.segments.length; index < chunks.length; index++) {
      const chunk = chunks[index];
      if (chunk === undefined) continue;
      const streaming = index === chunks.length - 1;
      const created = await this.transport.createCard(
        managedCardSpec(this.statusContent, chunk, streaming),
      );
      const sent = await this.sendSegment(created.cardId);
      this.segments.push({
        cardId: created.cardId,
        messageId: sent.messageId,
        sequence: 0,
        bodyContent: chunk,
        streaming,
      });
    }
    this.fullBody = nextBody;
  }

  async complete(): Promise<void> {
    if (this.finalContent) {
      await this.commitFinal();
      return;
    }
    const errors: unknown[] = [];
    for (const segment of this.segments) {
      try {
        await this.updateWholeCard(segment, false);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "failed to finalize managed CardKit stream");
  }

  setFinalContent(status: string, body: string): void {
    this.finalContent = { status, body };
  }

  private async commitFinal(): Promise<void> {
    const { status, body } = this.finalContent!;
    await this.transport.saveFinalContent?.(status, body);
    if (this.deliveryUncertain) throw new Error("CardKit send acknowledgement missing; delivery retained for recovery");
    const chunks = splitManagedMarkdown(body || BODY_STREAM_PREFIX);
    // Allocate only genuinely necessary continuation cards. Existing entities
    // are reused even if the final answer revises or shortens the live draft.
    while (this.segments.length < chunks.length) {
      const created = await this.transport.createCard(managedCardSpec("⏳ 正在保存回复", BODY_STREAM_PREFIX, false));
      const sent = await this.sendSegment(created.cardId);
      this.segments.push({ cardId: created.cardId, messageId: sent.messageId, sequence: 0, bodyContent: "", streaming: false });
    }
    const plans = this.segments.map((segment, index) => ({
      cardId: segment.cardId,
      card: managedCardSpec(status, chunks[index] ?? "正文已更新至前方卡片。", false),
    }));
    // Persist ALL final bodies before exposing a success marker on any card.
    await this.transport.saveFinal?.(plans);
    const errors: unknown[] = [];
    for (let index = 0; index < this.segments.length; index++) {
      const segment = this.segments[index]!;
      const plan = plans[index]!;
      let committed = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.transport.updateCard(segment.cardId, plan.card, this.nextSequence(segment));
          if (this.transport.verifyCard) {
            let verified = false;
            for (let read = 0; read < 3; read++) {
              if (await this.transport.verifyCard(segment.messageId, plan.card)) { verified = true; break; }
              if (read < 2) await new Promise(resolve => setTimeout(resolve, 300 * (read + 1)));
            }
            if (!verified) throw new Error(`final body not confirmed for ${segment.messageId}`);
          }
          segment.bodyContent = chunks[index] ?? "正文已更新至前方卡片。";
          segment.streaming = false;
          committed = true;
          break;
        } catch (err) {
          if (attempt === 2) errors.push(err);
          else await new Promise(resolve => setTimeout(resolve, 300 * 2 ** attempt));
        }
      }
      if (!committed) console.warn(`[card] final segment delivery pending message_id=${segment.messageId}`);
    }
    if (errors.length) throw new AggregateError(errors, "final CardKit delivery pending");
  }

  private async sendSegment(cardId: string): Promise<{ messageId: string }> {
    try {
      return await this.transport.sendCard(this.chatId, cardId, this.replyToMessageId, this.replyInThread);
    } catch (err) {
      this.deliveryUncertain = true;
      throw err;
    }
  }

  async replaceHead(card: object): Promise<void> {
    const head = this.segments[0];
    if (!head) throw new Error("managed CardKit stream has no head segment");
    await this.transport.updateCard(head.cardId, card, this.nextSequence(head));
  }

  private activeSegment(): CardSegment {
    const active = this.segments.at(-1);
    if (!active) throw new Error("managed CardKit stream has no active segment");
    return active;
  }

  private nextSequence(segment: CardSegment): number {
    segment.sequence++;
    return segment.sequence;
  }

  private async updateBody(segment: CardSegment, content: string): Promise<void> {
    await this.transport.updateElement(
      segment.cardId,
      BODY_ELEMENT_ID,
      content,
      this.nextSequence(segment),
    );
    segment.bodyContent = content;
  }

  private async updateWholeCard(segment: CardSegment, streaming: boolean): Promise<void> {
    await this.transport.updateCard(
      segment.cardId,
      managedCardSpec(this.statusContent, segment.bodyContent, streaming),
      this.nextSequence(segment),
    );
    segment.streaming = streaming;
  }
}
