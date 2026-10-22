import { mkdir } from "node:fs/promises";
import type { SessionStore, SessionRecord } from "../claude/sessionStore.js";
import { runAgent, type RunHandle, type RunOptions } from "../claude/runner.js";
import { runTrackedAgent } from "../history/trackedRunner.js";
import type { HistoryStore } from "../history/store.js";
import type { WechatConfig } from "./config.js";
import type { WechatInboundEvent, WechatMessageClient } from "./client.js";

// The bound WeChat account uses one local work directory. Serialize Codex turns
// across conversations so two chats cannot edit the same checkout concurrently.
const MAX_CONCURRENT = 1;
const USER_STOP_REASON = "wechat-user-stop";
const SHUTDOWN_REASON = "wechat-shutdown";

type AgentRunner = (options: RunOptions) => RunHandle;
type WechatCommand = "new" | "stop" | "status" | undefined;

export interface WechatHandlerDeps {
  client: WechatMessageClient;
  sessionStore: SessionStore;
  config: WechatConfig;
  runAgentFn?: AgentRunner;
  history?: HistoryStore;
}

export function parseWechatCommand(text: string): WechatCommand {
  const normalized = text.trim().toLowerCase();
  if (["/new", "新对话", "重新开始"].includes(normalized)) return "new";
  if (["/stop", "停止", "中止"].includes(normalized)) return "stop";
  if (["/status", "状态"].includes(normalized)) return "status";
  return undefined;
}

export function formatDuration(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function renderWechatPrompt(options: {
  text: string;
  isNewSession: boolean;
  config: WechatConfig;
}): string {
  if (!options.isNewSession) return options.text;
  return [
    options.config.agentSystemPrompt,
    `你的当前工作目录是：${options.config.workDir}`,
    "",
    "微信用户消息：",
    options.text,
  ]
    .filter((part, index) => part !== "" || index >= 2)
    .join("\n");
}

export class WechatHandler {
  readonly #deps: WechatHandlerDeps;
  readonly #runAgent: AgentRunner;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #inflight = new Map<string, AbortController>();
  readonly #pending = new Map<string, Set<AbortController>>();
  #closed = false;
  #running = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(deps: WechatHandlerDeps) {
    this.#deps = deps;
    this.#runAgent = deps.runAgentFn ?? runAgent;
  }

  async run(): Promise<void> {
    for await (const event of this.#deps.client.events()) {
      if (this.#closed) {
        event.retry();
        break;
      }
      const key = event.conversationId;
      const command = parseWechatCommand(event.text);

      if (command === "stop") {
        try {
          const pending = this.#pending.get(key);
          if (pending && [...pending].some((controller) => !controller.signal.aborted)) {
            for (const controller of pending) controller.abort(USER_STOP_REASON);
            await this.#deps.client.sendText(event, "⏸️ 已请求停止当前处理。");
          } else {
            await this.#deps.client.sendText(event, "当前没有正在处理的任务。");
          }
        } catch (err) {
          console.error(`[wechat-handler] 无法发送停止确认 conversation=${key}:`, err);
        } finally {
          event.ack();
        }
        continue;
      }
      if (command === "status") {
        try {
          const session = this.#deps.sessionStore.get(key);
          await this.#deps.client.sendText(
            event,
            [
              "微信 bridge 正常运行。",
              `当前处理：${this.#inflight.has(key) ? "进行中" : this.#pending.has(key) ? "排队中" : "空闲"}`,
              `Codex 会话：${session ? "已建立" : "尚未建立"}`,
              `工作目录：${this.#deps.config.workDir}`,
              `沙箱：${this.#deps.config.codexSandbox}`,
            ].join("\n"),
          );
        } catch (err) {
          console.error(`[wechat-handler] 无法发送状态 conversation=${key}:`, err);
        } finally {
          event.ack();
        }
        continue;
      }

      const controller = new AbortController();
      const pending = this.#pending.get(key) ?? new Set<AbortController>();
      pending.add(controller);
      this.#pending.set(key, pending);
      const previous = this.#queues.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => this.#acquire())
        .then(async () => {
          // Shutdown must leave not-yet-started messages available for replay.
          // An explicit /stop, in contrast, intentionally cancels queued work.
          if (this.#closed) {
            if (controller.signal.reason === USER_STOP_REASON) event.ack();
            else event.retry();
            return;
          }
          this.#inflight.set(key, controller);
          try {
            const handled = await this.#handleOne(event, command, controller.signal);
            if (!handled) {
              event.retry();
              return;
            }
          } catch (err) {
            console.error(`[wechat-handler] conversation ${key}:`, err);
          }
          event.ack();
        })
        .finally(() => {
          this.#release();
          if (this.#inflight.get(key) === controller) this.#inflight.delete(key);
          pending.delete(controller);
          if (pending.size === 0) this.#pending.delete(key);
          if (this.#queues.get(key) === next) this.#queues.delete(key);
        })
        .catch((err: unknown) => console.error(`[wechat-handler] conversation ${key}:`, err));
      this.#queues.set(key, next);
    }
    await Promise.allSettled(this.#queues.values());
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#inflight.values()) controller.abort(SHUTDOWN_REASON);
    await Promise.allSettled(this.#queues.values());
  }

  async #handleOne(
    event: WechatInboundEvent,
    command: WechatCommand,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return signal.reason === USER_STOP_REASON || !this.#closed;
    const startedAt = Date.now();
    const key = event.conversationId;

    if (command === "new") {
      await this.#deps.sessionStore.delete(key);
      await this.#deps.client.sendText(event, "✅ 已开始一个新的 Codex 对话。");
      return true;
    }
    if (!event.text) {
      await this.#deps.client.sendText(event, "目前只支持文字和带转写文本的语音消息。");
      return true;
    }

    await mkdir(this.#deps.config.workDir, { recursive: true });
    const stopTyping = await this.#deps.client.startTyping(event);
    let existing = this.#deps.sessionStore.get(key);
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (signal.aborted) return signal.reason === USER_STOP_REASON || !this.#closed;
        let lastText = "";
        let resultFailed = false;
        let agentProgress = false;
        const prompt = renderWechatPrompt({
          text: event.text,
          isNewSession: existing === undefined,
          config: this.#deps.config,
        });
        const handle = runTrackedAgent({
          agentKind: "codex",
          agentBinPath: this.#deps.config.agentBin,
          prompt,
          resumeSessionId: existing?.sessionId,
          cwd: this.#deps.config.workDir,
          timeoutMs: this.#deps.config.subprocessTimeoutMs,
          abortSignal: signal,
          codexExecutionPolicy: {
            mode: "sandbox",
            sandbox: this.#deps.config.codexSandbox,
            approveForMe: this.#deps.config.codexApproveForMe,
          },
        }, this.#deps.history, {
          platform: "wechat", conversationId: key, title: event.text.slice(0, 200),
        }, this.#runAgent);
        let sessionId: string | undefined;
        try {
          for await (const agentEvent of handle.events) {
            if (agentEvent.type === "system_init") sessionId = agentEvent.sessionId;
            if (agentEvent.type === "text_delta") lastText = agentEvent.text;
            if (agentEvent.type === "result" && agentEvent.isError) resultFailed = true;
            if (["text_delta", "tool_started", "tool_finished"].includes(agentEvent.type)) agentProgress = true;
          }
          const result = await handle.done;
          await this.#saveSession(key, event.fromUserId, existing, sessionId);
          if (signal.aborted || result.termination === "interrupted") {
            await this.#deps.client.sendText(
              event,
              `⏸️ 处理已中断（用时 ${formatDuration(Date.now() - startedAt)}）。`,
            );
            return true;
          }
          if (result.termination === "timeout") {
            await this.#deps.client.sendText(
              event,
              `⏱️ 处理超时（用时 ${formatDuration(Date.now() - startedAt)}）。请缩小任务范围后重试。`,
            );
            return true;
          }
          if (result.exitCode !== 0 || resultFailed) {
            throw new Error(`Codex 本轮执行失败（exitCode=${result.exitCode}）。`);
          }
          const body = lastText.trim() || "本轮 Codex 没有返回可展示的文字。";
          await this.#deps.client.sendText(
            event,
            `✅ 回复完成（用时 ${formatDuration(Date.now() - startedAt)}）\n\n${body}`,
          );
          return true;
        } catch (err) {
          handle.kill();
          await handle.done.catch(() => undefined);
          await this.#saveSession(key, event.fromUserId, existing, sessionId);
          if (signal.aborted) {
            await this.#deps.client.sendText(
              event,
              `⏸️ 处理已中断（用时 ${formatDuration(Date.now() - startedAt)}）。`,
            );
            return true;
          }
          const message = String((err as Error).message ?? err);
          if (attempt === 1 && existing && !agentProgress && isStaleResumeError(message)) {
            console.warn(`[wechat-handler] session ${existing.sessionId} 无法续接，改用新会话重试。`);
            await this.#deps.sessionStore.delete(key);
            existing = undefined;
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      console.error(`[wechat-handler] Codex 处理失败 conversation=${key}:`, err);
      await this.#deps.client.sendText(
        event,
        `❌ 处理失败（用时 ${formatDuration(Date.now() - startedAt)}）。请查看本机微信 bridge 日志后重试。`,
      );
    } finally {
      await stopTyping();
    }
    return true;
  }

  async #saveSession(
    key: string,
    senderId: string,
    existing: SessionRecord | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    const now = Date.now();
    if (sessionId) {
      await this.#deps.sessionStore.put({
        threadId: key,
        sessionId,
        createdTs: existing?.createdTs ?? now,
        lastActiveTs: now,
        senderOpenId: senderId,
      });
    } else if (existing) {
      await this.#deps.sessionStore.put({ ...existing, lastActiveTs: now });
    }
  }

  async #acquire(): Promise<void> {
    if (this.#running < MAX_CONCURRENT) {
      this.#running++;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#running--;
  }
}

function isStaleResumeError(message: string): boolean {
  return /(?:no (?:conversation|rollout|session)(?:\s+found|\s+with|\s+for)|(?:conversation|rollout|session)(?:\s+[^\n]{0,200})?\s+(?:not found|does not exist)|(?:could not|cannot|failed to) (?:find|load) (?:conversation|rollout|session))/i.test(message);
}
