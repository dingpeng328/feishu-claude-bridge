import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WechatCredentialStore, WechatDeliveryState } from "./state.js";

describe("WeChat private state", () => {
  it("persists credentials with owner-only permissions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wechat-credentials-"));
    const file = path.join(dir, "account.json");
    const store = new WechatCredentialStore(file);
    await store.save({
      accountId: "bot-1",
      userId: "user-1",
      token: "do-not-log-me",
      baseUrl: "https://example.com",
      connectedAt: 1,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await store.load())?.accountId).toBe("bot-1");
  });

  it("persists cursor and deduplicates processed message IDs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wechat-delivery-"));
    const file = path.join(dir, "delivery.json");
    const state = await WechatDeliveryState.load(file);
    await state.commit("message-1", "cursor-1");
    const restored = await WechatDeliveryState.load(file);
    expect(restored.cursor).toBe("cursor-1");
    expect(restored.has("message-1")).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ cursor: "cursor-1" });
  });
});
