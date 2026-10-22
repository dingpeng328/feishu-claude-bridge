import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readdir, readFile, open } from "node:fs/promises";
import path from "node:path";
import { _redactSecrets } from "../logger.js";

export type RunStatus = "running" | "completed" | "failed" | "interrupted" | "timeout" | "abandoned";
export interface RunSummary {
  id: string;
  platform: "feishu" | "wechat";
  conversationId: string;
  messageId?: string;
  title: string;
  agent: string;
  model?: string;
  cwd?: string;
  sessionId?: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  pid: number;
}
export interface HistoryEvent {
  time: number;
  type: string;
  [key: string]: unknown;
}
const ID = /^[a-f0-9-]{36}$/;
const SENSITIVE = /^(?:authorization|cookie|(?:\w+[_-])?(?:password|passwd|api[_-]?key|app[_-]?secret|(?:access|refresh|bot|context)[_-]?token))$/i;

function sanitize(value: unknown, key = ""): unknown {
  if (SENSITIVE.test(key)) return "<redacted>";
  if (typeof value === "string") return _redactSecrets(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  }
  return value;
}

/** Each attempt owns its files; Feishu, WeChat and the read-only viewer never share writes. */
export class HistoryStore {
  constructor(readonly directory: string) {}

  begin(input: Omit<RunSummary, "id" | "startedAt" | "status" | "pid">): RunTrace | undefined {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const summary = sanitize({ ...input, id: randomUUID(), startedAt: Date.now(), status: "running",
        pid: process.pid }) as RunSummary;
      return new RunTrace(this.directory, summary);
    } catch (err) {
      console.error("[history] 无法创建执行记录：", err);
      return undefined; // Observability must not prevent replies.
    }
  }
}

export class RunTrace {
  private disabled = false;
  constructor(private readonly directory: string, readonly summary: RunSummary) {
    this.save();
  }
  private save(): void {
    const file = path.join(this.directory, `${this.summary.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(this.summary), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  private safely(action: () => void): void {
    if (this.disabled) return;
    try { action(); } catch (err) {
      this.disabled = true;
      console.error("[history] 记录写入失败，本次执行继续但不再记录：", err);
    }
  }
  record(event: { type: string; [key: string]: unknown }): void {
    this.safely(() => {
      const clean = sanitize({ ...event, time: Date.now() }) as HistoryEvent;
      let line = JSON.stringify(clean);
      // Keep records individually readable within the API's 1 MiB incremental window.
      if (Buffer.byteLength(line) > 256 * 1024) {
        line = JSON.stringify({ time: clean.time, type: clean.type, truncated: true,
          preview: line.slice(0, 32_000), note: "单条事件超过 256 KiB，仅保留预览。" });
      }
      appendFileSync(path.join(this.directory, `${this.summary.id}.jsonl`), `${line}\n`, { mode: 0o600 });
    });
  }
  session(sessionId: string): void {
    this.summary.sessionId = sessionId;
    this.safely(() => this.save());
  }
  finish(status: RunStatus, detail: Record<string, unknown> = {}): void {
    if (this.summary.endedAt) return;
    this.record({ type: "execution_finished", status, ...detail });
    this.summary.status = status;
    this.summary.endedAt = Date.now();
    this.safely(() => this.save());
  }
}

/** Read from disk on demand, including records produced by another live bridge process. */
export class HistoryReader {
  constructor(readonly directories: string[]) {}

  async list(): Promise<RunSummary[]> {
    const groups = await Promise.all(this.directories.map(async directory => {
      let files: string[];
      try { files = await readdir(directory); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const runs: RunSummary[] = [];
      for (const file of files) {
        if (!file.endsWith(".json") || !ID.test(file.slice(0, -5))) continue;
        try {
          const run = JSON.parse(await readFile(path.join(directory, file), "utf8")) as RunSummary;
          if (run.id !== file.slice(0, -5) || typeof run.title !== "string" || !Number.isFinite(run.startedAt)) continue;
          if (run.status === "running") {
            try { process.kill(run.pid, 0); } catch (err) {
              if ((err as NodeJS.ErrnoException).code === "ESRCH") run.status = "abandoned";
            }
          }
          runs.push(run);
        } catch { /* One damaged archive must not hide the other conversations. */ }
      }
      return runs;
    }));
    return groups.flat().sort((a, b) => b.startedAt - a.startedAt);
  }

  async events(id: string, offset: number): Promise<{ events: HistoryEvent[]; nextOffset: number; hasMore: boolean } | undefined> {
    if (!ID.test(id)) return undefined;
    for (const directory of this.directories) {
      // A summary exists before the first event and remains after a crash.
      try { await readFile(path.join(directory, `${id}.json`), "utf8"); } catch { continue; }
      let file;
      try { file = await open(path.join(directory, `${id}.jsonl`), "r"); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { events: [], nextOffset: 0, hasMore: false };
        throw err;
      }
      try {
        const size = (await file.stat()).size;
        if (offset > size) throw new Error("Invalid event offset");
        const buffer = Buffer.alloc(Math.min(1024 * 1024, size - offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(10);
        const consumed = lastNewline + 1;
        const events: HistoryEvent[] = [];
        for (const line of buffer.subarray(0, consumed).toString("utf8").split("\n")) {
          if (!line) continue;
          try { events.push(JSON.parse(line) as HistoryEvent); } catch { /* Skip a damaged line. */ }
        }
        return { events, nextOffset: offset + consumed, hasMore: consumed > 0 && offset + consumed < size };
      } finally { await file.close(); }
    }
    return undefined;
  }
}
