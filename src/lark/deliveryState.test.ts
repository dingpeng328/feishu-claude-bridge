import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeliveryState } from "./deliveryState.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fcb-delivery-"));
  dirs.push(dir);
  return join(dir, "delivery-state.json");
}

describe("DeliveryState", () => {
  it("persists cursor, known chats and seen mention ids", async () => {
    const path = await statePath();
    const state = await DeliveryState.load(path, { now: 10_000 });
    state.rememberChat("oc_1");
    state.rememberMention("om_1", 9_000);
    state.advanceCursor(10_000);
    await state.close();

    const reloaded = await DeliveryState.load(path, { now: 10_500 });
    expect(reloaded.cursorMs).toBe(10_000);
    expect(reloaded.knownChatIds).toEqual(["oc_1"]);
    expect(reloaded.hasSeen("om_1")).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
  });

  it("prunes old mention ids while retaining recent ones", async () => {
    const path = await statePath();
    const state = await DeliveryState.load(path, { seenTtlMs: 1_000, now: 2_000 });
    state.rememberMention("om_old", 500);
    state.rememberMention("om_recent", 1_500);
    await state.close();

    const reloaded = await DeliveryState.load(path, { seenTtlMs: 1_000, now: 2_000 });
    expect(reloaded.hasSeen("om_old")).toBe(false);
    expect(reloaded.hasSeen("om_recent")).toBe(true);
  });
});
