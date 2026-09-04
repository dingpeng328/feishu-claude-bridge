/**
 * src/bridge/handler.ts
 *
 * Orchestrates the per-message lifecycle:
 *   events → parseMessage → sessionStore.get → card.start → renderPrompt
 *   → runAgent → for-await stream → card.handle → card.finalize → sessionStore.put
 *
 * Concurrency: each topic (threadId) gets its own serial promise chain (ordered
 * within a topic), different topics run concurrently, capped by a semaphore.
 *
 * Pure-chat: the agent's reply = its streamed assistant text; success = exitCode 0.
 * No worktree, no state.json contract.
 */

import fs from "node:fs/promises";
import type { LarkMessageEvent } from "../lark/transport.js";
import type { ChannelClient, ThreadContextMessage } from "../lark/channel.js";
import type { CardRenderer, CardHandle } from "../lark/card.js";
import type { SessionStore } from "../claude/sessionStore.js";
import { parseMessage, sessionKeyOf } from "../lark/message.js";
import { renderPrompt } from "../claude/prompt.js";
import { runAgent, type AgentKind } from "../claude/runner.js";

const MAX_CONCURRENT = 5;

export interface BridgeHandlerDeps {
  client: ChannelClient;
  cardRenderer: CardRenderer;
  sessionStore: SessionStore;
  /** Shared cwd the agent subprocess runs in (same for all topics). */
  workDir: string;
  agentKind: AgentKind;
  agentBin: string;
  /** Role/behavior instructions for newly-created agent sessions. */
  agentSystemPrompt: string;
  subprocessTimeoutMs: number;
}

export class BridgeHandler {
  private readonly deps: BridgeHandlerDeps;
  private closed = false;

  constructor(deps: BridgeHandlerDeps) {
    this.deps = deps;
  }

  /** Main loop: per-thread serial chains + global concurrency semaphore. */
  async run(opts?: { abortSignal?: AbortSignal }): Promise<void> {
    const signal = opts?.abortSignal;
    const threadQueues = new Map<string, Promise<void>>();
    // Per-thread abort handle for the CURRENT (latest) turn. A new message on the
    // same thread aborts the in-flight turn (interrupt) before scheduling itself.
    const inflight = new Map<string, AbortController>();

    let running = 0;
    const waiters: Array<() => void> = [];
    const acquire = (): Promise<void> => {
      if (running < MAX_CONCURRENT) {
        running++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => waiters.push(resolve));
    };
    const release = (): void => {
      const next = waiters.shift();
      if (next) next();
      else running--;
    };

    for await (const event of this.deps.client.events()) {
      if (this.closed || signal?.aborted) break;
      // MUST match handleOne's session key (parseMessage.threadId), so a
      // top-level @ and its in-thread replies group together and interrupt works.
      const key = sessionKeyOf(event);

      const decision = this.decideIncoming(event);
      if (decision === "ignore") {
        console.log(
          `[handler] ignored message_id=${event.message_id} thread=${key} reason=missing-bot-mention`,
        );
        continue;
      }
      if (decision === "close") {
        console.log(`[handler] thread ${key}: marked resolved, clearing session`);
        await this.deps.sessionStore.delete(key);
        continue;
      }

      // Interrupt: a new message on the same thread aborts the in-flight turn so
      // this one takes over (resuming the same agent session), rather than queuing.
      const prevController = inflight.get(key);
      if (prevController && !prevController.signal.aborted) {
        console.log(`[handler] thread ${key}: new message — interrupting in-flight turn`);
        prevController.abort();
      }
      const controller = new AbortController();
      inflight.set(key, controller); // becomes the latest turn (overwrites prev)

      const prev = threadQueues.get(key) ?? Promise.resolve();
      const next = prev
        .then(() => acquire())
        .then(() => this.handleOne(event, controller.signal))
        .catch((err: unknown) => {
          console.error(`[handler] unhandled error on thread ${key}:`, err);
        })
        .finally(() => {
          release();
          // Only the latest turn clears the entries (an aborted older turn must not).
          if (inflight.get(key) === controller) inflight.delete(key);
          if (threadQueues.get(key) === next) threadQueues.delete(key);
        });
      threadQueues.set(key, next);
    }
  }

  /** Soft-close: run() exits at the next loop iteration; in-flight turns finish. */
  async close(): Promise<void> {
    this.closed = true;
  }

  // ---------------------------------------------------------------------------

  /**
   * Group policy: every message, including replies inside an existing topic,
   * must directly @mention the bot. Direct messages do not need a mention.
   * A mentioned resolution message clears the topic's persisted agent session.
   */
  private decideIncoming(event: LarkMessageEvent): "handle" | "ignore" | "close" {
    const isGroupMessage = event.chat_type !== "p2p";
    if (isGroupMessage && event.mentioned_bot !== true) return "ignore";
    if (isResolutionMessage(event)) return "close";
    return "handle";
  }

  private async handleOne(event: LarkMessageEvent, signal?: AbortSignal): Promise<void> {
    const parsed = parseMessage(event);
    const { threadId, messageId, senderOpenId } = parsed;

    // Already superseded before we even started (e.g. several messages arrived in
    // a burst) — skip cleanly so we don't spawn a claude that's instantly killed.
    if (signal?.aborted) return;

    const existing = this.deps.sessionStore.get(threadId);

    // Top-level @ (no root_id) → reply_in_thread to open a Feishu topic.
    const isTopLevel = !(typeof event.root_id === "string" && event.root_id);

    // A group-topic @ must be answered against a fresh snapshot of the whole
    // topic, including non-mention discussion that the event stream intentionally
    // filters out. Direct messages and top-level group messages keep the existing
    // single-message path.
    const isGroupTopic = event.chat_type !== "p2p" && Boolean(event.thread_id || event.root_id);

    // Feishu topic history is the cross-machine source of truth. A replayed
    // mention may be new to this machine's delivery-state.json even though the
    // same bot already answered it elsewhere. Check before creating our own
    // thinking card, otherwise that card would look like the prior answer.
    let threadContext: ThreadContextMessage[] | undefined;
    if (isGroupTopic) {
      try {
        threadContext = await this.deps.client.getThreadContext(
          event.thread_id ?? event.root_id ?? messageId,
          event.root_id ?? messageId,
          event,
        );
      } catch (err) {
        console.error("[handler] failed to inspect topic history for thread", threadId, err);
        const failureCard = await this.startCard(event.chat_id, messageId, isTopLevel, threadId);
        if (failureCard) {
          await failureCard.finalize({ success: false, failureReason: String(err) });
        }
        return;
      }

      const handledReply = findBotReplyAfterEvent(
        threadContext,
        event,
        this.deps.client.getBotSenderIds(),
      );
      if (handledReply) {
        console.log(
          `[handler] skipped message_id=${messageId} thread=${threadId} ` +
            `reason=topic-already-handled reply_message_id=${handledReply.messageId}`,
        );
        return;
      }
    }

    const card = await this.startCard(event.chat_id, messageId, isTopLevel, threadId);

    try {
      // Shared cwd for all topics (e.g. a real repo). Topics stay isolated by
      // their own agent session (--resume/resume by threadId), not by separate dirs.
      const cwd = this.deps.workDir;
      await fs.mkdir(cwd, { recursive: true }); // no-op if it already exists

      // One stale-session retry: if --resume hits a ghost session, drop it and retry fresh.
      let currentExisting = existing;
      let attempt = 0;

      while (true) {
        attempt++;
        if (signal?.aborted) {
          if (card) await card.finalize({ success: false, interrupted: true });
          return;
        }
        const isNewThread = currentExisting === undefined;
        const prompt = renderPrompt({
          parsed,
          isNewThread,
          workDir: cwd,
          systemPrompt: this.deps.agentSystemPrompt,
          threadContext,
        });

        const handle = runAgent({
          agentKind: this.deps.agentKind,
          prompt,
          resumeSessionId: currentExisting?.sessionId,
          cwd,
          timeoutMs: this.deps.subprocessTimeoutMs,
          agentBinPath: this.deps.agentBin,
          abortSignal: signal, // interrupt → SIGTERM the agent subprocess
        });

        let sessionId: string | undefined;
        let lastText = "";

        try {
          for await (const ev of handle.events) {
            if (card) card.handle(ev);
            if (ev.type === "system_init") sessionId = ev.sessionId;
            if (ev.type === "text_delta") lastText = ev.text;
          }
          const result = await handle.done;
          const now = Date.now();

          // Persist session id (even if interrupted) so the next/newer turn can
          // resume the SAME agent session and continue with the new message.
          if (sessionId !== undefined) {
            await this.deps.sessionStore.put({
              threadId,
              sessionId,
              createdTs: currentExisting?.createdTs ?? now,
              lastActiveTs: now,
              senderOpenId,
            });
          } else if (currentExisting !== undefined) {
            await this.deps.sessionStore.put({ ...currentExisting, lastActiveTs: now });
          }

          // Interrupted by a newer message on the same thread: mark this card and
          // step aside — the newer turn (already scheduled) resumes the session.
          if (signal?.aborted) {
            console.log(`[handler] thread ${threadId}: turn interrupted, yielding to newer message`);
            if (card) await card.finalize({ finalText: lastText, success: false, interrupted: true });
            return;
          }

          if (card) {
            const success = result.exitCode === 0;
            const cardBody = lastText.trim()
              ? lastText
              : "⚠️ 本轮没有拿到 agent 的回复(可能被中断),再 @ 我一次重试。";
            await card.finalize({ finalText: cardBody, success });
          }
          break; // done
        } catch (spawnErr) {
          // If we were interrupted, a kill-induced error is expected — treat as
          // interrupted (⏸️), not a failure. Persist sessionId if we got one.
          if (signal?.aborted) {
            if (sessionId !== undefined) {
              await this.deps.sessionStore.put({
                threadId,
                sessionId,
                createdTs: currentExisting?.createdTs ?? Date.now(),
                lastActiveTs: Date.now(),
                senderOpenId,
              });
            }
            console.log(`[handler] thread ${threadId}: turn interrupted (during run), yielding`);
            if (card) await card.finalize({ finalText: lastText, success: false, interrupted: true });
            return;
          }
          const errMsg = String((spawnErr as Error).message ?? spawnErr);
          // A turn launched WITH --resume failed. Most often the resumed session
          // is corrupt — e.g. an interrupt (SIGTERM) landed mid tool-call, leaving
          // a half-written tool_use in claude's session history, so the next
          // resume makes the model emit an unparseable tool call ("could not be
          // parsed") and claude exits 1. Also covers a ghost session
          // ("No conversation found"). Self-heal: drop the session and retry ONCE
          // fresh (loses the interrupted turn's context, but returns a real reply
          // instead of an error card). Bounded by attempt===1.
          const resumeLikelyBad =
            currentExisting != null &&
            (errMsg.includes("No conversation found") ||
              errMsg.includes("could not be parsed") ||
              errMsg.includes("exited with code 1"));
          if (attempt === 1 && resumeLikelyBad) {
            console.warn(
              `[handler] thread ${threadId}: resumed session ${currentExisting?.sessionId} likely ` +
                `corrupt — dropping it and retrying fresh. cause: ${errMsg.slice(0, 140)}`,
            );
            await this.deps.sessionStore.delete(threadId);
            currentExisting = undefined;
            continue;
          }
          throw spawnErr;
        }
      }
    } catch (err) {
      const interrupted = signal?.aborted === true;
      if (!interrupted) console.error("[handler] handleOne failed for thread", threadId, err);
      if (card) {
        try {
          await card.finalize(
            interrupted
              ? { success: false, interrupted: true }
              : { success: false, failureReason: String(err) },
          );
        } catch (finalizeErr) {
          console.error("[handler] finalize also failed:", finalizeErr);
        }
      }
    }
  }

  private async startCard(
    chatId: string,
    messageId: string,
    replyInThread: boolean,
    threadId: string,
  ): Promise<CardHandle | undefined> {
    try {
      return await this.deps.cardRenderer.start(chatId, messageId, { replyInThread });
    } catch (err) {
      console.error("[handler] failed to start card for thread", threadId, err);
      // Continue without a card — session bookkeeping still matters.
      return undefined;
    }
  }
}

function eventTimestampMs(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function findBotReplyAfterEvent(
  context: ThreadContextMessage[],
  event: LarkMessageEvent,
  botSenderIds: string[],
): ThreadContextMessage | undefined {
  if (botSenderIds.length === 0) return undefined;
  const senderIds = new Set(botSenderIds);

  const currentIndex = context.findIndex((message) => message.messageId === event.message_id);
  if (currentIndex >= 0) {
    return context.slice(currentIndex + 1).find((message) => isCompletedBotReply(message, senderIds));
  }

  const eventTime = eventTimestampMs(event.create_time);
  return context.find(
    (message) =>
      isCompletedBotReply(message, senderIds) && eventTimestampMs(message.createTime) > eventTime,
  );
}

function isCompletedBotReply(message: ThreadContextMessage, botSenderIds: Set<string>): boolean {
  if (!botSenderIds.has(message.senderId)) return false;
  // Bridge replies are interactive cards. Only a completed native stream (or a
  // legacy green card) proves another instance finished; in-progress,
  // interrupted, and failed cards remain retryable.
  return message.msgType !== "interactive" || message.cardStatus === "success";
}

function eventText(event: LarkMessageEvent): string {
  try {
    const parsed = JSON.parse(event.content) as Record<string, unknown>;
    if (typeof parsed["text"] === "string") return parsed["text"].trim();
  } catch {
    // Fall through to raw text.
  }
  return String(event.content ?? "").trim();
}

function isResolutionMessage(event: LarkMessageEvent): boolean {
  const text = eventText(event).replace(/@_\w+\s*/g, "").trim().toLowerCase();
  return /^(已解决|解决了|问题解决了|搞定了|关闭|结束|done|resolved|close|closed)$/i.test(text);
}
