import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _redactSecrets } from "./logger.js";

describe("persistent logger redaction", () => {
  it("redacts bearer tokens and common credential fields", () => {
    const input =
      "Authorization: Bearer token-value app_secret=secret-value cookie=session-value " +
      'bot_token="bot-value" context_token="context-value"';
    const out = _redactSecrets(input);
    expect(out).not.toContain("token-value");
    expect(out).not.toContain("secret-value");
    expect(out).not.toContain("session-value");
    expect(out).not.toContain("bot-value");
    expect(out).not.toContain("context-value");
    expect(out).toContain("Bearer <redacted>");
  });

  it("redacts quoted credentials, API keys and environment-variable credentials in free text", () => {
    const out = _redactSecrets(
      'OPENAI_API_KEY=sk-key-value ANTHROPIC_API_KEY="another-key" ' +
      'password="two word secret" cookie="session=one; account=two" ' +
      'refresh_token=refresh-value appSecret=app-value',
    );
    for (const secret of ['sk-key-value', 'another-key', 'two word secret', 'session=one', 'account=two', 'refresh-value', 'app-value']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('OPENAI_API_KEY=');
  });

  it("redacts both console output and the persistent log", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bridge-logger-test-"));
    const original = { log: console.log, warn: console.warn, error: console.error };
    const printed = vi.fn();
    console.log = printed;
    try {
      vi.resetModules();
      const { installPersistentLogging } = await import("./logger.js");
      const file = path.join(dir, "bridge.log");
      installPersistentLogging(file);
      console.log("request: %o", { app_secret: "fixture-secret", api_key: "fixture-key" });
      expect(JSON.stringify(printed.mock.calls)).not.toContain("fixture-secret");
      expect(JSON.stringify(printed.mock.calls)).not.toContain("fixture-key");
      const saved = await readFile(file, "utf8");
      expect(saved).not.toContain("fixture-secret");
      expect(saved).not.toContain("fixture-key");
      expect(saved).toContain("<redacted>");
    } finally {
      Object.assign(console, original);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
