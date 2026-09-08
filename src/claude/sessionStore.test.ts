import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "./sessionStore.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fcb-sess-"));
  file = path.join(dir, "sessions.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SessionStore", () => {
  it("creates an empty store when file is absent", async () => {
    const store = await SessionStore.load(file);
    expect(store.list()).toHaveLength(0);
  });

  it("put/get round-trips and persists across reload", async () => {
    const store = await SessionStore.load(file);
    await store.put({ threadId: "om_t", sessionId: "sess_1", createdTs: 1, lastActiveTs: 2 });
    expect(store.get("om_t")?.sessionId).toBe("sess_1");

    const reloaded = await SessionStore.load(file);
    expect(reloaded.get("om_t")?.sessionId).toBe("sess_1");
  });

  it("discards sessions from an earlier runtime when requested", async () => {
    const previousRuntime = await SessionStore.load(file);
    await previousRuntime.put({
      threadId: "om_old",
      sessionId: "sess_old",
      createdTs: 1,
      lastActiveTs: 2,
    });

    const newRuntime = await SessionStore.load(file, { discardExisting: true });
    expect(newRuntime.get("om_old")).toBeUndefined();
    expect(newRuntime.list()).toHaveLength(0);

    // The reset is durable too: no later load can accidentally revive the old id.
    const reloaded = await SessionStore.load(file);
    expect(reloaded.list()).toHaveLength(0);
  });

  it("delete removes the record", async () => {
    const store = await SessionStore.load(file);
    await store.put({ threadId: "om_t", sessionId: "sess_1", createdTs: 1, lastActiveTs: 2 });
    await store.delete("om_t");
    expect(store.get("om_t")).toBeUndefined();
  });
});
