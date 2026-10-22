import type { WechatConfig } from "./config.js";
import {
  extractWechatText,
  getWechatConversationId,
  getWechatMessageId,
  WechatMessageState,
  WechatMessageType,
  WechatProtocolClient,
  type WechatMessage,
} from "./protocol.js";
import type { WechatCredentials, WechatDeliveryState } from "./state.js";

const DEFAULT_LONG_POLL_MS = 35_000;
const MAX_SEND_CHARS = 3_500;

export interface WechatInboundEvent {
  message: WechatMessage;
  messageId: string;
  conversationId: string;
  fromUserId: string;
  text: string;
  contextToken?: string;
  runId?: string;
  /** Mark the inbound message handled so its durable delivery cursor may advance. */
  ack(): void;
  /** Keep this message for replay and stop receiving new messages in this runtime. */
  retry(): void;
}

export interface WechatMessageClient {
  events(): AsyncIterable<WechatInboundEvent>;
  sendText(event: WechatInboundEvent, text: string): Promise<void>;
  startTyping(event: WechatInboundEvent): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      finish();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function splitText(text: string, maxChars = MAX_SEND_CHARS): string[] {
  const chars = [...text];
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += maxChars) {
    chunks.push(chars.slice(index, index + maxChars).join(""));
  }
  return chunks.length > 0 ? chunks : [""];
}

export class WechatClient implements WechatMessageClient {
  readonly #credentials: WechatCredentials;
  readonly #delivery: WechatDeliveryState;
  readonly #protocol: WechatProtocolClient;
  readonly #abortController = new AbortController();
  readonly #seenInRuntime = new Set<string>();
  #notifiedStarted = false;
  #persistenceTail: Promise<void> = Promise.resolve();
  #cursorBlocked = false;

  constructor(options: {
    config: WechatConfig;
    credentials: WechatCredentials;
    delivery: WechatDeliveryState;
  }) {
    this.#credentials = options.credentials;
    this.#delivery = options.delivery;
    this.#protocol = new WechatProtocolClient({
      baseUrl: options.credentials.baseUrl || options.config.apiBaseUrl,
      token: options.credentials.token,
      botAgent: options.config.botAgent,
    });
  }

  async *events(): AsyncGenerator<WechatInboundEvent> {
    await this.#protocol.notifyStarted();
    this.#notifiedStarted = true;
    let timeoutMs = DEFAULT_LONG_POLL_MS;
    let failures = 0;
    let pollCursor = this.#delivery.cursor;

    while (!this.#abortController.signal.aborted) {
      try {
        const response = await this.#protocol.getUpdates(
          pollCursor,
          timeoutMs,
          this.#abortController.signal,
        );
        if (this.#abortController.signal.aborted) break;
        if (response.longpolling_timeout_ms && response.longpolling_timeout_ms > 0) {
          timeoutMs = response.longpolling_timeout_ms;
        }
        const apiError =
          (response.ret !== undefined && response.ret !== 0) ||
          (response.errcode !== undefined && response.errcode !== 0);
        if (apiError) {
          failures++;
          console.error(
            `[wechat-client] getupdates 失败：ret=${response.ret ?? "-"} ` +
              `errcode=${response.errcode ?? "-"} ${response.errmsg ?? ""}`,
          );
          const staleSession = response.errcode === -14 || response.ret === -14;
          if (staleSession) {
            console.error("[wechat-client] 微信会话暂时失效，将暂停一小时；若持续出现，请用 --login 重新连接。");
          }
          const backoff = staleSession ? 60 * 60_000 : failures >= 3 ? 30_000 : 2_000;
          await sleep(backoff, this.#abortController.signal);
          continue;
        }

        failures = 0;
        const nextCursor = response.get_updates_buf;
        if (nextCursor) pollCursor = nextCursor;
        const batchAcks: Array<{ messageId: string; handled: Promise<boolean> }> = [];
        const messages = response.msgs ?? [];
        let visited = 0;
        try {
          for (const message of messages) {
            if (this.#abortController.signal.aborted) {
              break;
            }
            visited++;
            const messageId = getWechatMessageId(message);
            if (!messageId || this.#delivery.has(messageId) || this.#seenInRuntime.has(messageId)) continue;
            const fromUserId = message.from_user_id?.trim() || "";
            const isUserMessage = message.message_type === WechatMessageType.USER;
            const isFinished =
              message.message_state === undefined || message.message_state === WechatMessageState.FINISH;
            // A later update may carry the final text under the same message ID.
            // Partial messages must not poison either durable or runtime deduplication.
            if (isUserMessage && !isFinished && fromUserId === this.#credentials.userId) continue;
            this.#seenInRuntime.add(messageId);
            if (!isUserMessage || fromUserId !== this.#credentials.userId) {
              batchAcks.push({ messageId, handled: Promise.resolve(true) });
              continue;
            }

            let acknowledged = false;
            let acknowledge!: (handled: boolean) => void;
            const handled = new Promise<boolean>((resolve) => {
              acknowledge = resolve;
            });
            batchAcks.push({ messageId, handled });
            yield {
              message,
              messageId,
              conversationId: getWechatConversationId(message),
              fromUserId,
              text: extractWechatText(message),
              contextToken: message.context_token,
              runId: message.run_id,
              ack: () => {
                if (acknowledged) return;
                acknowledged = true;
                acknowledge(true);
              },
              retry: () => {
                if (acknowledged) return;
                acknowledged = true;
                acknowledge(false);
                this.#abortController.abort();
              },
            };
          }
        } finally {
          // Poll again using the server cursor immediately, but serialize durable
          // cursor writes behind per-message acknowledgements. If the process
          // crashes mid-turn, the old cursor remains and that message is replayed.
          this.#persistenceTail = this.#persistenceTail.then(async () => {
            for (const item of batchAcks) {
              if (await item.handled) {
                await this.#delivery.commit(item.messageId, undefined);
                this.#seenInRuntime.delete(item.messageId);
              } else {
                this.#cursorBlocked = true;
              }
            }
            if (visited < messages.length) this.#cursorBlocked = true;
            if (!this.#cursorBlocked && nextCursor) await this.#delivery.commit(undefined, nextCursor);
          });
          // flush() observes the rejection during shutdown; this attached handler
          // also prevents an early unhandled-rejection warning while turns run.
          void this.#persistenceTail.catch((err) => {
            console.error(`[wechat-client] 无法持久化消息游标：${String(err)}`);
            this.#abortController.abort();
          });
        }
      } catch (err) {
        if (this.#abortController.signal.aborted) break;
        failures++;
        console.error(`[wechat-client] 长轮询异常（${failures}）：${String(err)}`);
        await sleep(failures >= 3 ? 30_000 : 2_000, this.#abortController.signal);
      }
    }
  }

  async sendText(event: WechatInboundEvent, text: string): Promise<void> {
    for (const chunk of splitText(text)) {
      await this.#protocol.sendText({
        to: event.fromUserId,
        text: chunk,
        contextToken: event.contextToken,
        runId: event.runId,
      });
    }
  }

  async startTyping(event: WechatInboundEvent): Promise<() => Promise<void>> {
    let stopped = false;
    let ticket: string | undefined;
    try {
      ticket = await this.#protocol.getTypingTicket(event.fromUserId, event.contextToken);
      if (ticket) await this.#protocol.sendTyping(event.fromUserId, ticket, true);
    } catch (err) {
      console.warn(`[wechat-client] 无法启动输入状态：${String(err)}`);
    }
    const interval = ticket
      ? setInterval(() => {
          if (!stopped && ticket) {
            void this.#protocol.sendTyping(event.fromUserId, ticket, true).catch((err) => {
              console.warn(`[wechat-client] 刷新输入状态失败：${String(err)}`);
            });
          }
        }, 15_000)
      : undefined;
    interval?.unref();

    return async () => {
      if (stopped) return;
      stopped = true;
      if (interval) clearInterval(interval);
      if (ticket) {
        await this.#protocol.sendTyping(event.fromUserId, ticket, false).catch((err) => {
          console.warn(`[wechat-client] 结束输入状态失败：${String(err)}`);
        });
      }
    };
  }

  async close(): Promise<void> {
    this.#abortController.abort();
    if (this.#notifiedStarted) {
      await this.#protocol.notifyStopped().catch((err) => {
        console.warn(`[wechat-client] notifystop 失败：${String(err)}`);
      });
    }
  }

  async flush(): Promise<void> {
    await this.#persistenceTail;
  }
}

export { splitText as _splitText };
