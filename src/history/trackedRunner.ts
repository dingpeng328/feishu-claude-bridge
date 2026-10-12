import { runAgent, type RunHandle, type RunOptions } from "../claude/runner.js";
import type { HistoryStore, RunSummary } from "./store.js";

export function runTrackedAgent(
  options: RunOptions,
  history: HistoryStore | undefined,
  context: Pick<RunSummary, "platform" | "conversationId" | "messageId" | "title">,
  runner: (options: RunOptions) => RunHandle = runAgent,
): RunHandle {
  if (!history) return runner(options);
  const trace = history.begin({ ...context, agent: options.agentKind ?? "claude", model: options.model,
    cwd: options.cwd, sessionId: options.resumeSessionId });
  if (!trace) return runner(options);
  trace.record({ type: "execution_started", prompt: options.prompt, resumeSessionId: options.resumeSessionId });
  let handle: RunHandle;
  try {
    handle = runner({ ...options, onStderr: text => {
      trace.record({ type: "stderr", text });
      options.onStderr?.(text);
    } });
  } catch (err) {
    trace.finish("failed", { error: String(err) });
    throw err;
  }
  let streamFailed = false;
  let resultFailed = false;
  let drained!: () => void;
  const streamDone = new Promise<void>(resolve => { drained = resolve; });
  async function* events(): RunHandle["events"] {
    try {
      for await (const event of handle.events) {
        trace!.record(event);
        if (event.type === "system_init") trace!.session(event.sessionId);
        if (event.type === "result" && event.isError) resultFailed = true;
        yield event;
      }
    } catch (err) {
      streamFailed = true;
      trace!.record({ type: "stream_error", error: String(err) });
      throw err;
    } finally { drained(); }
  }
  const done = handle.done.then(async result => {
    await streamDone;
    trace.finish(result.termination ?? (result.exitCode === 0 && !streamFailed && !resultFailed ? "completed" : "failed"), result);
    return result;
  }, async err => {
    await streamDone;
    trace.finish(options.abortSignal?.aborted ? "interrupted" : "failed", { error: String(err) });
    throw err;
  });
  void done.catch(() => undefined);
  return { events: events(), done, kill: () => handle.kill() };
}
