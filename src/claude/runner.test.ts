import { describe, it, expect } from "vitest";
import { _parseLinesMulti, _buildEnv, _buildCommand } from "./runner.js";

describe("_parseLinesMulti", () => {
  it("parses system init → session_id", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "sess_42" });
    const events = [..._parseLinesMulti(line)];
    expect(events).toEqual([{ type: "system_init", sessionId: "sess_42", raw: expect.anything() }]);
  });

  it("parses assistant text + tool_use blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { id: "msg_1", content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] },
    });
    const events = [..._parseLinesMulti(line)];
    expect(events[0]).toMatchObject({ type: "text_delta", text: "hi" });
    expect(events[1]).toMatchObject({ type: "tool_use", toolName: "Bash", toolInput: { command: "ls" } });
  });

  it("parses result with stop_reason", () => {
    const line = JSON.stringify({ type: "result", stop_reason: "end_turn" });
    expect([..._parseLinesMulti(line)][0]).toMatchObject({ type: "result", stopReason: "end_turn" });
  });

  it("parses user tool_result", () => {
    const line = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } });
    expect([..._parseLinesMulti(line)][0]).toMatchObject({ type: "tool_result" });
  });

  it("empty line yields nothing; bad JSON yields raw", () => {
    expect([..._parseLinesMulti("   ")]).toHaveLength(0);
    expect([..._parseLinesMulti("{bad")][0]).toMatchObject({ type: "raw" });
  });
});

describe("_buildEnv", () => {
  it("strips ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-be-removed";
    const env = _buildEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
  });
});

describe("codex support", () => {
  it("parses codex thread + answer + result events", () => {
    expect([
      ..._parseLinesMulti(
        JSON.stringify({ type: "thread.started", thread_id: "019f1205-f484-7cf0-a461-911761b26ba1" }),
        "codex",
      ),
    ][0]).toMatchObject({
      type: "system_init",
      sessionId: "019f1205-f484-7cf0-a461-911761b26ba1",
    });
    expect([
      ..._parseLinesMulti(
        JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "OK" } }),
        "codex",
      ),
    ][0]).toMatchObject({ type: "text_delta", text: "OK" });
    expect([..._parseLinesMulti(JSON.stringify({ type: "turn.completed" }), "codex")][0]).toMatchObject({
      type: "result",
      stopReason: "turn_completed",
    });
  });

  it("builds codex exec and resume commands", () => {
    expect(_buildCommand({ agentKind: "codex", prompt: "hi" })).toEqual([
      "codex",
      [
        "--dangerously-bypass-approvals-and-sandbox",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "hi",
      ],
    ]);
    expect(_buildCommand({ agentKind: "codex", prompt: "hi", resumeSessionId: "thread_1" })).toEqual([
      "codex",
      [
        "--dangerously-bypass-approvals-and-sandbox",
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        "thread_1",
        "hi",
      ],
    ]);
  });

  it("builds sandboxed codex commands for an unattended channel", () => {
    const policy = { mode: "sandbox", sandbox: "workspace-write", approveForMe: true } as const;
    expect(_buildCommand({ agentKind: "codex", prompt: "hi", codexExecutionPolicy: policy })).toEqual([
      "codex",
      [
        "exec",
        "--approve-for-me",
        "--json",
        "--skip-git-repo-check",
        "hi",
      ],
    ]);
    expect(
      _buildCommand({
        agentKind: "codex",
        prompt: "again",
        resumeSessionId: "thread_1",
        codexExecutionPolicy: policy,
      }),
    ).toEqual([
      "codex",
      [
        "exec",
        "--approve-for-me",
        "resume",
        "--json",
        "--skip-git-repo-check",
        "thread_1",
        "again",
      ],
    ]);
  });

  it("uses an explicit sandbox only when automatic approval is disabled", () => {
    expect(
      _buildCommand({
        agentKind: "codex",
        prompt: "inspect",
        codexExecutionPolicy: { mode: "sandbox", sandbox: "read-only", approveForMe: false },
      }),
    ).toEqual([
      "codex",
      ["exec", "--sandbox", "read-only", "--json", "--skip-git-repo-check", "inspect"],
    ]);
  });
});
