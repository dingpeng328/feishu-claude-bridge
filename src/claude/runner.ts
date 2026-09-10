/**
 * src/claude/runner.ts
 *
 * Spawns the `claude` CLI as a child process, parses its stream-json NDJSON
 * output line-by-line, and yields typed events via an AsyncIterable.
 *
 * Kept (cheap robustness):
 *  - ANTHROPIC_API_KEY stripped from env (subscription mode, not API billing)
 *  - SIGTERM → 5s grace → SIGKILL
 *  - grandchild-block workaround: a dev server spawned non-detached can hold the
 *    stdio pipe open after the agent finishes; the exit/close fallback + readline
 *    abort let the handler still reach finalize().
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type AgentKind = "claude" | "codex";

export type CodexExecutionPolicy =
  | { mode: "dangerous-bypass" }
  | {
      mode: "sandbox";
      sandbox: "read-only" | "workspace-write";
      approveForMe?: boolean;
    };

export type AgentStreamEvent =
  | { type: "system_init"; sessionId: string; raw: unknown }
  | { type: "text_delta"; text: string; raw: unknown }
  | { type: "tool_use"; toolName: string; toolInput: unknown; raw: unknown }
  | { type: "tool_result"; raw: unknown }
  | { type: "result"; stopReason: string; raw: unknown }
  | { type: "raw"; raw: unknown };

export interface RunOptions {
  /** @default 'claude' */
  agentKind?: AgentKind;
  prompt: string;
  resumeSessionId?: string;
  /** @default 'bypassPermissions' */
  permissionMode?: "acceptEdits" | "ask" | "bypassPermissions";
  /** Child process cwd (the sandbox boundary). */
  cwd?: string;
  /** @default 30 min */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Codex-only execution policy. Omitted preserves the legacy bypass behavior. */
  codexExecutionPolicy?: CodexExecutionPolicy;
  /** @default depends on agentKind */
  agentBinPath?: string;
  /** @deprecated use agentBinPath */
  claudeBinPath?: string;
}

export interface RunHandle {
  events: AsyncIterable<AgentStreamEvent>;
  done: Promise<{ exitCode: number; sessionId?: string }>;
  kill(): void;
}

const SIGKILL_GRACE_MS = 5_000;
const GRANDCHILD_GRACE_MS = 30_000;
// After SIGKILL, if the OS still hasn't delivered 'exit'/'close' for this child
// (e.g. SIGCHLD lost across a macOS sleep/wake, or a wedged grandchild holding
// the stdio pipe), force-settle `done` anyway so the caller's turn can never hang.
const POST_KILL_FORCE_MS = 2_000;

/** Inherit env, strip ANTHROPIC_API_KEY so the subscription account is used. */
function buildEnv(agentKind: AgentKind = "claude"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (agentKind === "claude") delete env["ANTHROPIC_API_KEY"];
  return env;
}

function buildCommand(opts: RunOptions): [string, string[]] {
  const agentKind = opts.agentKind ?? "claude";
  if (agentKind === "codex") return buildCodexCommand(opts);

  const bin = opts.agentBinPath ?? opts.claudeBinPath ?? "claude";
  const mode = opts.permissionMode ?? "bypassPermissions";
  const args: string[] = [
    "--permission-mode",
    mode,
    "--output-format",
    "stream-json",
    // claude requires --verbose alongside --output-format=stream-json under -p.
    "--verbose",
    "--include-partial-messages",
  ];
  if (opts.resumeSessionId != null) args.push("--resume", opts.resumeSessionId);
  args.push("-p", opts.prompt);
  return [bin, args];
}

function buildCodexCommand(opts: RunOptions): [string, string[]] {
  const bin = opts.agentBinPath ?? "codex";
  const policy = opts.codexExecutionPolicy ?? { mode: "dangerous-bypass" };
  const args: string[] = [];
  if (policy.mode === "dangerous-bypass") {
    // Keep the historical Feishu launch shape byte-for-byte compatible.
    args.push("--dangerously-bypass-approvals-and-sandbox", "exec");
  } else if (policy.approveForMe === true) {
    // Codex defines --approve-for-me as its own workspace-write policy and
    // rejects it when --sandbox is also present.
    if (policy.sandbox !== "workspace-write") {
      throw new Error("Codex --approve-for-me requires the workspace-write policy.");
    }
    args.push("exec", "--approve-for-me");
  } else {
    args.push("exec", "--sandbox", policy.sandbox);
  }
  const execArgs = ["--json", "--skip-git-repo-check"];
  if (opts.resumeSessionId != null) {
    args.push("resume", ...execArgs, opts.resumeSessionId, opts.prompt);
  } else {
    args.push(...execArgs, opts.prompt);
  }
  return [bin, args];
}

/** Yield all events from a single NDJSON line (an assistant msg may carry many blocks). */
function* parseLinesMulti(line: string, agentKind: AgentKind = "claude"): Generator<AgentStreamEvent> {
  const trimmed = line.trim();
  if (trimmed === "") return;

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    yield { type: "raw", raw: trimmed };
    return;
  }
  if (typeof obj !== "object" || obj === null) {
    yield { type: "raw", raw: obj };
    return;
  }
  if (agentKind === "codex") {
    yield* parseCodexObject(obj);
    return;
  }
  yield* parseClaudeObject(obj);
}

function* parseClaudeObject(obj: unknown): Generator<AgentStreamEvent> {
  const record = obj as Record<string, unknown>;
  const eventType = record["type"];

  if (eventType === "system" && record["subtype"] === "init" && typeof record["session_id"] === "string") {
    yield { type: "system_init", sessionId: record["session_id"], raw: obj };
    return;
  }
  if (eventType === "result") {
    const stopReason = typeof record["stop_reason"] === "string" ? record["stop_reason"] : "unknown";
    yield { type: "result", stopReason, raw: obj };
    return;
  }
  if (eventType === "assistant") {
    const message = record["message"];
    if (
      typeof message === "object" &&
      message !== null &&
      Array.isArray((message as Record<string, unknown>)["content"])
    ) {
      const content = (message as Record<string, unknown>)["content"] as unknown[];
      let emitted = false;
      for (const item of content) {
        if (typeof item !== "object" || item === null) continue;
        const block = item as Record<string, unknown>;
        if (block["type"] === "text" && typeof block["text"] === "string") {
          yield { type: "text_delta", text: block["text"], raw: obj };
          emitted = true;
        } else if (block["type"] === "tool_use") {
          yield {
            type: "tool_use",
            toolName: typeof block["name"] === "string" ? block["name"] : "unknown",
            toolInput: block["input"] ?? null,
            raw: obj,
          };
          emitted = true;
        }
      }
      if (!emitted) yield { type: "raw", raw: obj };
      return;
    }
    yield { type: "raw", raw: obj };
    return;
  }
  if (eventType === "user") {
    const message = record["message"];
    if (
      typeof message === "object" &&
      message !== null &&
      Array.isArray((message as Record<string, unknown>)["content"])
    ) {
      const content = (message as Record<string, unknown>)["content"] as unknown[];
      for (const item of content) {
        if (typeof item !== "object" || item === null) continue;
        if ((item as Record<string, unknown>)["type"] === "tool_result") {
          yield { type: "tool_result", raw: obj };
          return;
        }
      }
    }
    yield { type: "raw", raw: obj };
    return;
  }
  yield { type: "raw", raw: obj };
}

function* parseCodexObject(obj: unknown): Generator<AgentStreamEvent> {
  if (typeof obj !== "object" || obj === null) {
    yield { type: "raw", raw: obj };
    return;
  }
  const record = obj as Record<string, unknown>;
  const eventType = record["type"];

  if (eventType === "thread.started" && typeof record["thread_id"] === "string") {
    yield { type: "system_init", sessionId: record["thread_id"], raw: obj };
    return;
  }
  if (eventType === "turn.completed") {
    yield { type: "result", stopReason: "turn_completed", raw: obj };
    return;
  }
  if (eventType === "error") {
    yield { type: "raw", raw: obj };
    return;
  }

  const item = record["item"];
  if (typeof item !== "object" || item === null) {
    yield { type: "raw", raw: obj };
    return;
  }
  const itemRecord = item as Record<string, unknown>;
  const itemType = itemRecord["type"];
  if (typeof itemRecord["text"] === "string" && (itemType === "agent_message" || itemType === "message")) {
    yield { type: "text_delta", text: itemRecord["text"], raw: obj };
    return;
  }
  if (eventType === "item.started" || eventType === "item.completed") {
    const toolName =
      typeof itemType === "string" && itemType.length > 0
        ? itemType
        : typeof itemRecord["name"] === "string"
          ? itemRecord["name"]
          : "tool";
    if (toolName !== "agent_message" && toolName !== "message") {
      yield { type: "tool_use", toolName, toolInput: item, raw: obj };
      return;
    }
  }
  yield { type: "raw", raw: obj };
}

export function runAgent(opts: RunOptions): RunHandle {
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const agentKind = opts.agentKind ?? "claude";
  const [bin, args] = buildCommand(opts);
  const env = buildEnv(agentKind);

  const child = spawn(bin, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...(opts.cwd != null ? { cwd: opts.cwd } : {}),
  });

  let discoveredSessionId: string | undefined;

  // ── kill helper (SIGTERM → grace → SIGKILL → force-settle) ────────────────
  // forceSettle is wired up below once the `done` promise's resolver exists; it
  // lets doKill guarantee `done` terminates even if the child's exit/close event
  // is never delivered (lost SIGCHLD after sleep, wedged grandchild stdio).
  let forceSettle: ((exitCode: number) => void) | undefined;
  let killScheduled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let postKillTimer: ReturnType<typeof setTimeout> | undefined;
  function doKill(): void {
    if (killScheduled) return;
    killScheduled = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      // Last resort: the process should be gone now. If 'close'/'exit' still
      // don't fire shortly, settle `done` ourselves so the turn can't wedge.
      postKillTimer = setTimeout(() => forceSettle?.(137), POST_KILL_FORCE_MS);
      postKillTimer.unref();
    }, SIGKILL_GRACE_MS);
    killTimer.unref();
  }

  // ── grandchild-block workaround: force-kill 30s after result ──────────────
  let grandchildGraceTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleGrandchildGrace(): void {
    if (grandchildGraceTimer !== undefined) return;
    grandchildGraceTimer = setTimeout(() => {
      grandchildGraceTimer = undefined;
      if (!child.killed && !killScheduled) {
        console.warn(
          "[runner] claude still running 30s after result — likely a non-detached grandchild " +
            "(e.g. dev server) holding stdio. Sending SIGTERM.",
        );
        doKill();
      }
    }, GRANDCHILD_GRACE_MS);
    grandchildGraceTimer.unref();
  }

  const timeoutHandle = setTimeout(doKill, timeoutMs);
  timeoutHandle.unref();

  if (opts.abortSignal != null) {
    if (opts.abortSignal.aborted) doKill();
    else opts.abortSignal.addEventListener("abort", doKill, { once: true });
  }

  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  // AbortController forcibly closes readline so the events loop unblocks even
  // when child.stdout hasn't drained (grandchild holding the pipe).
  const rlAbortController = new AbortController();

  const done = new Promise<{ exitCode: number; sessionId?: string }>((resolve, reject) => {
    let settled = false;
    const finalizeResolve = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(killTimer);
      clearTimeout(postKillTimer);
      clearTimeout(grandchildGraceTimer);
      rlAbortController.abort();
      if (exitCode !== 0 && !killScheduled) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(`${agentKind} exited with code ${exitCode}` + (stderr ? `\nstderr: ${stderr}` : "")));
        return;
      }
      resolve({ exitCode, sessionId: discoveredSessionId });
    };
    // Let doKill force-settle `done` once the child is (presumed) dead but the
    // OS never delivered its exit/close — guarded by `settled`, so harmless if
    // the real close already landed.
    forceSettle = finalizeResolve;

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(killTimer);
      clearTimeout(postKillTimer);
      rlAbortController.abort();
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `${agentKind === "codex" ? "Codex" : "Claude"} CLI not found: "${bin}". ` +
              `Install it and ensure it's on PATH, or set AGENT_BIN.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    child.on("close", (code: number | null) => finalizeResolve(code ?? 1));

    // Fallback: 'exit' fired (process gone) but 'close' (stdio drained) didn't
    // within 5s — grandchild holding stdio. Force-resolve so the handler can finalize.
    child.on("exit", (code: number | null) => {
      if (settled) return;
      const t = setTimeout(() => {
        if (settled) return;
        console.warn(
          `[runner] child pid=${child.pid} exited (code=${code ?? "signal"}) but 'close' didn't ` +
            `fire within 5s — force-resolving + aborting readline.`,
        );
        finalizeResolve(code ?? 1);
      }, 5_000);
      t.unref();
    });
  });

  async function* generateEvents(): AsyncGenerator<AgentStreamEvent> {
    const rl = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
      signal: rlAbortController.signal,
    });
    try {
      for await (const line of rl) {
        for (const event of parseLinesMulti(line, agentKind)) {
          if (event.type === "system_init") discoveredSessionId = event.sessionId;
          if (event.type === "result") scheduleGrandchildGrace();
          yield event;
        }
      }
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR");
      if (!isAbort) throw err;
    } finally {
      rl.close();
    }
  }

  return { events: generateEvents(), done, kill: doKill };
}

export function runClaude(opts: RunOptions): RunHandle {
  return runAgent({ ...opts, agentKind: "claude" });
}

// Re-export for unit tests.
export { parseLinesMulti as _parseLinesMulti, buildEnv as _buildEnv, buildCommand as _buildCommand };
