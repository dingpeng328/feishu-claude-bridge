/**
 * src/lark/transport.ts
 *
 * Transport-neutral types + the AsyncQueue used to bridge the SDK's event
 * callbacks into an async generator. This is a single-bot chat bridge.
 */

// ---------------------------------------------------------------------------
// Inbound message shape
// ---------------------------------------------------------------------------

export interface LarkMessageEvent {
  message_id: string;
  chat_id: string;
  /** 'p2p' | 'group' | 'topic_group' etc. */
  chat_type: string;
  thread_id?: string;
  /** Root message id of the topic thread (the first @ that opened it). */
  root_id?: string;
  /** open_id of the sender */
  sender_id: string;
  mentions?: Array<{
    key?: string;
    id: { open_id?: string; union_id?: string; user_id?: string | null };
    mentioned_type?: string;
    name?: string;
  }>;
  /** True when the inbound message directly mentioned this bot. */
  mentioned_bot?: boolean;
  /** True when the inbound message mentioned all members. */
  mention_all?: boolean;
  /** Raw JSON string — lark/message.ts is responsible for parsing. */
  content: string;
  create_time: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// AsyncQueue
// ---------------------------------------------------------------------------

/**
 * Minimal unbounded async queue: producers `push`, the single consumer awaits
 * `next()`. Event volume is low (one @ / message at a time), so unbounded is fine.
 */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  /** Signal that no more items will arrive. */
  close(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as unknown as T, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.done) return Promise.resolve({ value: undefined as unknown as T, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
