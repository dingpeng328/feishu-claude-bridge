import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface JournalCard {
  cardId: string;
  messageId?: string;
  sendStartedAtMs?: number;
  /** Reserved ceiling: recovery always supersedes any old in-flight update. */
  sequence: number;
  finalCard?: object;
}

export interface JournalTurn {
  messageId: string;
  chatId: string;
  replyInThread: boolean;
  startedAtMs: number;
  cards: JournalCard[];
  finalContent?: { status: string; body: string };
}

/** Durable delivery intent, separate from message dedup and CLI sessions.
 * Only unfinished turns are retained. Never used to replay agent execution.
 */
export class TurnJournal {
  private readonly turns = new Map<string, JournalTurn>();
  private writes: Promise<void> = Promise.resolve();
  private constructor(private readonly filePath: string) {}

  static async load(filePath: string): Promise<TurnJournal> {
    const journal = new TurnJournal(filePath);
    try {
      const data = JSON.parse(await readFile(filePath, "utf8")) as { version: number; turns: JournalTurn[] };
      if (data.version !== 1 || !Array.isArray(data.turns)) throw new Error("invalid pending-turn journal");
      for (const turn of data.turns) {
        if (!turn.messageId || !turn.chatId || !Array.isArray(turn.cards)
          || turn.cards.some(c => !c.cardId || !Number.isFinite(c.sequence))) {
          throw new Error("invalid pending-turn record");
        }
        journal.turns.set(turn.messageId, turn);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return journal;
  }

  list(): JournalTurn[] { return structuredClone([...this.turns.values()]); }
  get(messageId: string): JournalTurn | undefined {
    const turn = this.turns.get(messageId);
    return turn ? structuredClone(turn) : undefined;
  }

  async begin(turn: Omit<JournalTurn, "cards">): Promise<void> {
    if (this.turns.has(turn.messageId)) { await this.flush(); return; }
    this.turns.set(turn.messageId, { ...turn, cards: [] });
    await this.flush();
  }

  async recordCard(messageId: string, cardId: string, sentMessageId?: string): Promise<void> {
    const turn = this.turns.get(messageId);
    if (!turn) throw new Error("card created without a durable turn");
    let card = turn.cards.find(c => c.cardId === cardId);
    if (!card) {
      card = { cardId, sequence: 1000 };
      turn.cards.push(card);
    }
    if (sentMessageId) card.messageId = sentMessageId;
    await this.flush();
  }

  async reserveSequence(messageId: string, cardId: string, sequence: number): Promise<void> {
    const card = this.turns.get(messageId)?.cards.find(c => c.cardId === cardId);
    if (!card) throw new Error("untracked CardKit entity");
    if (sequence <= card.sequence) { await this.writes; return; }
    card.sequence = Math.ceil(sequence / 1000) * 1000;
    await this.flush();
  }

  async markSending(messageId: string, cardId: string): Promise<void> {
    const card = this.turns.get(messageId)?.cards.find(c => c.cardId === cardId);
    if (!card) throw new Error("untracked outgoing card");
    card.sendStartedAtMs = Date.now();
    await this.flush();
  }

  async saveFinalContent(messageId: string, status: string, body: string): Promise<void> {
    const turn = this.turns.get(messageId);
    if (!turn) throw new Error("missing final delivery intent");
    turn.finalContent = { status, body };
    await this.flush();
  }

  async saveFinal(messageId: string, plans: Array<{ cardId: string; card: object }>): Promise<void> {
    const turn = this.turns.get(messageId);
    if (!turn) throw new Error("missing final delivery intent");
    for (const plan of plans) {
      const entry = turn.cards.find(c => c.cardId === plan.cardId);
      if (!entry) throw new Error("final plan references an unknown card");
      entry.finalCard = structuredClone(plan.card);
    }
    await this.flush();
  }

  async remove(messageId: string): Promise<void> {
    this.turns.delete(messageId);
    await this.flush();
  }

  async close(): Promise<void> { await this.writes; }

  private flush(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, turns: [...this.turns.values()] });
    const write = this.writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(`${this.filePath}.tmp`, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(`${this.filePath}.tmp`, this.filePath);
    });
    this.writes = write;
    return write;
  }
}
