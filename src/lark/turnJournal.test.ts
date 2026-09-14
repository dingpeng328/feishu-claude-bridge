import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnJournal } from "./turnJournal.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("durable pending delivery", () => {
  it("retains the complete final answer and a sequence ceiling across restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fcb-journal-test-")); dirs.push(dir);
    const file = join(dir, "pending.json");
    const journal = await TurnJournal.load(file);
    await journal.begin({ messageId: "user", chatId: "chat", replyInThread: true, startedAtMs: 1 });
    await journal.recordCard("user", "card", "reply");
    await journal.reserveSequence("user", "card", 1001);
    await journal.saveFinal("user", [{ cardId: "card", card: { body: "entire final answer" } }]);
    const afterRestart = await TurnJournal.load(file);
    expect(afterRestart.get("user")?.cards).toEqual([{ cardId: "card", messageId: "reply", sequence: 2000, finalCard: { body: "entire final answer" } }]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await afterRestart.remove("user");
    expect((await TurnJournal.load(file)).list()).toEqual([]);
  });
});
