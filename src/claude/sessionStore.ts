/**
 * src/claude/sessionStore.ts
 *
 * threadId ↔ agent session_id runtime state for a single bot. The file is
 * flushed after every change, but main.ts starts each bridge process with an
 * empty store so sessions are never resumed across a restart.
 *
 *   - load(): missing file → fresh empty store (writes an empty file)
 *   - load({ discardExisting: true }) → fresh empty store for a new runtime
 *   - put()/delete() → immediate atomic flush (write .tmp, then rename)
 *   - close() → no-op flush hook (kept for symmetry with main.ts shutdown)
 */

import { rename, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionRecord {
  threadId: string;
  sessionId: string;
  /** ms epoch */
  createdTs: number;
  lastActiveTs: number;
  senderOpenId?: string;
}

interface StoreFile {
  records: Record<string, SessionRecord>;
}

interface LoadOptions {
  /** Ignore and replace records written by an earlier bridge process. */
  discardExisting?: boolean;
}

export class SessionStore {
  readonly #filePath: string;
  readonly #map: Map<string, SessionRecord>;

  private constructor(filePath: string, map: Map<string, SessionRecord>) {
    this.#filePath = filePath;
    this.#map = map;
  }

  /** Load sessions.json, or create a fresh empty store if requested/absent. */
  static async load(filePath: string, options: LoadOptions = {}): Promise<SessionStore> {
    if (options.discardExisting === true) {
      const store = new SessionStore(filePath, new Map());
      await store.#flush();
      return store;
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const store = new SessionStore(filePath, new Map());
        await store.#flush();
        return store;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`[SessionStore] ${filePath} is not valid JSON — fix or delete it and restart.`);
    }
    const records =
      typeof parsed === "object" && parsed !== null && "records" in parsed
        ? (parsed as { records: unknown }).records
        : {};
    const map = new Map<string, SessionRecord>();
    if (typeof records === "object" && records !== null) {
      for (const [key, value] of Object.entries(records as Record<string, unknown>)) {
        if (isRecord(value)) map.set(key, value);
      }
    }
    return new SessionStore(filePath, map);
  }

  get(threadId: string): SessionRecord | undefined {
    return this.#map.get(threadId);
  }

  async put(record: SessionRecord): Promise<void> {
    this.#map.set(record.threadId, record);
    await this.#flush();
  }

  async delete(threadId: string): Promise<void> {
    this.#map.delete(threadId);
    await this.#flush();
  }

  list(): readonly SessionRecord[] {
    return [...this.#map.values()];
  }

  async close(): Promise<void> {
    // No debounced writes outstanding (put/delete flush synchronously); kept for
    // a uniform shutdown contract with main.ts.
  }

  /** Atomic write: serialize → write .tmp → rename (POSIX atomic). */
  async #flush(): Promise<void> {
    const file: StoreFile = { records: Object.fromEntries(this.#map) };
    const tmpPath = `${this.#filePath}.tmp`;
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(tmpPath, JSON.stringify(file, null, 2), "utf8");
    await rename(tmpPath, this.#filePath);
  }
}

function isRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["threadId"] === "string" &&
    typeof v["sessionId"] === "string" &&
    typeof v["createdTs"] === "number" &&
    typeof v["lastActiveTs"] === "number"
  );
}
