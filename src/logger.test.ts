import { describe, expect, it } from "vitest";
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
});
