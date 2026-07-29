import { describe, expect, it } from "vitest";
import { _redactSecrets } from "./logger.js";

describe("persistent logger redaction", () => {
  it("redacts bearer tokens and common credential fields", () => {
    const input = "Authorization: Bearer token-value app_secret=secret-value cookie=session-value";
    const out = _redactSecrets(input);
    expect(out).not.toContain("token-value");
    expect(out).not.toContain("secret-value");
    expect(out).not.toContain("session-value");
    expect(out).toContain("Bearer <redacted>");
  });
});
