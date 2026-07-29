import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const VERSION = 1;
const DEFAULT_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface DeliveryStateFile {
  version: number;
  cursorMs: number;
  seen: Record<string, number>;
  knownChatIds: string[];
}

/**
 * Durable cursor + message-id ledger used by the HTTP catch-up path.
 *
 * Only bot mentions are kept in `seen`, so the file stays small even though the
 * WebSocket receives every message from an allowed group. Writes are serialized
 * and atomic; a crash can leave at most the `.tmp` file behind.
 */
export class DeliveryState {
  readonly #filePath: string;
  readonly #seen = new Map<string, number>();
  readonly #knownChatIds = new Set<string>();
  readonly #seenTtlMs: number;
  #cursorMs = 0;
  #flushChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, seenTtlMs: number) {
    this.#filePath = filePath;
    this.#seenTtlMs = seenTtlMs;
  }

  static async load(
    filePath: string,
    opts?: { seenTtlMs?: number; now?: number },
  ): Promise<DeliveryState> {
    const state = new DeliveryState(filePath, opts?.seenTtlMs ?? DEFAULT_SEEN_TTL_MS);
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<DeliveryStateFile>;
      if (parsed.version === VERSION && Number.isFinite(parsed.cursorMs)) {
        state.#cursorMs = Math.max(0, parsed.cursorMs ?? 0);
      }
      if (parsed.seen && typeof parsed.seen === "object") {
        for (const [id, ts] of Object.entries(parsed.seen)) {
          if (id && Number.isFinite(ts)) state.#seen.set(id, ts);
        }
      }
      if (Array.isArray(parsed.knownChatIds)) {
        for (const id of parsed.knownChatIds) if (typeof id === "string" && id) state.#knownChatIds.add(id);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[delivery] ignoring unreadable state ${filePath}:`, err);
      }
    }
    state.prune(opts?.now ?? Date.now());
    return state;
  }

  get cursorMs(): number {
    return this.#cursorMs;
  }

  get knownChatIds(): readonly string[] {
    return [...this.#knownChatIds];
  }

  hasSeen(messageId: string): boolean {
    return this.#seen.has(messageId);
  }

  rememberChat(chatId: string): void {
    if (!chatId || this.#knownChatIds.has(chatId)) return;
    this.#knownChatIds.add(chatId);
    this.scheduleFlush();
  }

  rememberMention(messageId: string, timestampMs = Date.now()): void {
    if (!messageId) return;
    this.#seen.set(messageId, timestampMs);
    this.prune(timestampMs);
    this.scheduleFlush();
  }

  advanceCursor(cursorMs: number): void {
    if (!Number.isFinite(cursorMs) || cursorMs <= this.#cursorMs) return;
    this.#cursorMs = cursorMs;
    this.scheduleFlush();
  }

  async close(): Promise<void> {
    await this.#flushChain;
  }

  private prune(now: number): void {
    const cutoff = now - this.#seenTtlMs;
    for (const [id, ts] of this.#seen) if (ts < cutoff) this.#seen.delete(id);
  }

  private scheduleFlush(): void {
    const snapshot: DeliveryStateFile = {
      version: VERSION,
      cursorMs: this.#cursorMs,
      seen: Object.fromEntries(this.#seen),
      knownChatIds: [...this.#knownChatIds],
    };
    this.#flushChain = this.#flushChain
      .then(async () => {
        await mkdir(dirname(this.#filePath), { recursive: true });
        const tmpPath = `${this.#filePath}.tmp`;
        await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
        await rename(tmpPath, this.#filePath);
      })
      .catch((err: unknown) => {
        console.error(`[delivery] failed to persist ${this.#filePath}:`, err);
      });
  }
}
