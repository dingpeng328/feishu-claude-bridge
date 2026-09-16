import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "./runner.js";

const dirs: string[] = [];
const ownedPids: number[] = [];
afterEach(async () => {
  for (const pid of ownedPids.splice(0)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("runner process lifecycle", () => {
  it.skipIf(process.platform === "win32")("preserves success when cleaning up a process that lingers after turn.completed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fcb-runner-completed-"));
    dirs.push(dir);
    const bin = join(dir, "agent.mjs");
    await writeFile(bin, `#!/usr/bin/env node
console.log(JSON.stringify({type:'thread.started',thread_id:'completed-session'}));
console.log(JSON.stringify({type:'turn.completed'}));
setInterval(()=>{},100);
`, { mode: 0o700 });

    const handle = runAgent({
      agentKind: "codex",
      agentBinPath: bin,
      prompt: "test",
      timeoutMs: 20_000,
      postResultGraceMs: 25,
    });
    for await (const _event of handle.events) { /* drain through cleanup */ }

    await expect(handle.done).resolves.toMatchObject({
      exitCode: 0,
      sessionId: "completed-session",
    });
    expect((await handle.done).termination).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("does not hide a failed Claude result during post-result cleanup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fcb-runner-failed-"));
    dirs.push(dir);
    const bin = join(dir, "agent.mjs");
    await writeFile(bin, `#!/usr/bin/env node
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'failed-session'}));
console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,stop_reason:'error'}));
setInterval(()=>{},100);
`, { mode: 0o700 });

    const handle = runAgent({
      agentKind: "claude",
      agentBinPath: bin,
      prompt: "test",
      timeoutMs: 20_000,
      postResultGraceMs: 25,
    });
    for await (const _event of handle.events) { /* drain through cleanup */ }

    await expect(handle.done).resolves.toMatchObject({ exitCode: 1 });
  });

  it.skipIf(process.platform === "win32")("waits for escalation when an exited parent leaves an ignoring tool process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fcb-runner-tree-")); dirs.push(dir);
    const bin = join(dir, "agent.mjs");
    await writeFile(bin, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
const tool = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); process.send(process.pid); setInterval(()=>{},100);'], {stdio:['ignore','ignore','ignore','ipc']});
tool.on('message', pid => console.log(JSON.stringify({type:'ready',pid:process.pid,toolPid:pid})));
`, { mode: 0o700 });
    const handle = runAgent({ agentKind: "codex", agentBinPath: bin, prompt: "test", timeoutMs: 20_000 });
    let toolPid = 0;
    let killedAt = 0;
    for await (const event of handle.events) {
      const raw = event.raw as { type?: string; pid?: number; toolPid?: number };
      if (raw.type === "ready" && raw.pid) {
        ownedPids.push(raw.pid); toolPid = raw.toolPid!; killedAt = Date.now(); handle.kill();
      }
    }
    await handle.done;
    expect(Date.now() - killedAt).toBeGreaterThanOrEqual(4500);
    await vi.waitFor(() => { expect(() => process.kill(toolPid, 0)).toThrow(); }, { timeout: 1500 });
  }, 12_000);

  it.skipIf(process.platform === "win32")("actually kills a SIGTERM-ignoring agent before declaring it stopped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fcb-runner-test-"));
    dirs.push(dir);
    const bin = join(dir, "agent.mjs");
    await writeFile(bin, '#!/usr/bin/env node\nprocess.on("SIGTERM",()=>{}); console.log(JSON.stringify({type:"ready",pid:process.pid})); setInterval(()=>{},100);', { mode: 0o700 });
    const handle = runAgent({ agentKind: "codex", agentBinPath: bin, prompt: "test", timeoutMs: 20_000 });
    let pid = 0;
    for await (const event of handle.events) {
      const raw = event.raw as { type?: string; pid?: number };
      if (raw.type === "ready" && raw.pid) {
        pid = raw.pid;
        ownedPids.push(pid);
        handle.kill();
      }
    }
    expect((await handle.done).termination).toBe("interrupted");
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 12_000);

  it("reports a missing executable without an unhandled done rejection", async () => {
    const handle = runAgent({ agentBinPath: "/nonexistent/fcb-agent", prompt: "test" });
    for await (const _event of handle.events) { /* drain before awaiting done */ }
    await expect(handle.done).rejects.toThrow("CLI not found");
  });
});
