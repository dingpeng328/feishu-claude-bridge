import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { HistoryReader, HistoryStore } from "./store.js";
import { runTrackedAgent } from "./trackedRunner.js";
import { startHistoryServer } from "./server.js";
import type { AgentStreamEvent, RunHandle } from "../claude/runner.js";

const dirs: string[] = [];
const servers: Awaited<ReturnType<typeof startHistoryServer>>[] = [];
afterEach(async () => {
  for (const { server } of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-history-test-")); dirs.push(dir);
  return { dir, store: new HistoryStore(dir), reader: new HistoryReader([dir]) };
}
const context = { platform: "feishu" as const, conversationId: "thread-a", messageId: "msg-a", title: "检查构建" };
const options = { prompt: "检查构建", agentKind: "claude" as const };
function fake(events: AgentStreamEvent[], result: Promise<Awaited<RunHandle['done']>> = Promise.resolve({ exitCode: 0 })): RunHandle {
  void result.catch(() => undefined);
  return { events: (async function* () { yield* events; })(), done: result, kill() {} };
}

describe("durable execution history", () => {
  it.skipIf(process.platform === 'win32')("captures a real runner's Codex JSON and stderr through process exit", async () => {
    const { store, reader, dir } = await setup();
    const bin = path.join(dir, 'fake-agent.mjs');
    await writeFile(bin, `#!/usr/bin/env node
console.error('fixture diagnostic');
console.log(JSON.stringify({type:'thread.started',thread_id:'codex-fixture'}));
console.log(JSON.stringify({type:'item.started',item:{id:'call-a',type:'command_execution',command:'pwd'}}));
console.log(JSON.stringify({type:'item.completed',item:{id:'call-a',type:'command_execution',aggregated_output:'/fixture',exit_code:0}}));
console.log(JSON.stringify({type:'item.completed',item:{id:'text-a',type:'agent_message',text:'完成'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`, { mode: 0o700 });
    const handle = runTrackedAgent({ ...options, agentKind: 'codex', agentBinPath: bin }, store, context);
    for await (const _event of handle.events) { /* drain the actual subprocess */ }
    await handle.done;
    const [run] = await reader.list();
    expect(run).toMatchObject({ status: 'completed', sessionId: 'codex-fixture' });
    const events = (await reader.events(run.id, 0))!.events;
    expect(events.some(event => event.type === 'stderr' && String(event.text).includes('fixture diagnostic'))).toBe(true);
    expect(events.filter(event => event.type.startsWith('tool_')).map(event => event.type)).toEqual(['tool_started', 'tool_finished']);
    expect(events.at(-1)?.type).toBe('execution_finished');
  });

  it("records both tool arguments and results, with terminal status after the final streamed event", async () => {
    const { store, reader, dir } = await setup();
    const handle = runTrackedAgent(options, store, context, opts => {
      opts.onStderr?.('diagnostic output');
      return fake([
        { type: "system_init", sessionId: "session-1", raw: {} },
        { type: "tool_started", callId: "call-1", toolName: "Bash", raw: { input: { command: "npm test" } } },
        { type: "tool_finished", callId: "call-1", isError: false, raw: { content: "3 tests passed" } },
        { type: "text_delta", text: "完成", raw: {} },
      ]);
    });
    for await (const _event of handle.events) { /* drain */ }
    await handle.done;
    const [summary] = await new HistoryReader([dir]).list();
    expect(summary).toMatchObject({ status: "completed", sessionId: "session-1", title: "检查构建" });
    const page = await reader.events(summary.id, 0);
    expect(page?.events.map(event => event.type)).toEqual([
      "execution_started", "stderr", "system_init", "tool_started", "tool_finished", "text_delta", "execution_finished",
    ]);
    expect(page?.events[3].raw).toEqual({ input: { command: "npm test" } });
    expect((await reader.events(summary.id, page!.nextOffset))?.events).toEqual([]);
    if (process.platform !== 'win32') expect((await stat(path.join(dir, `${summary.id}.jsonl`))).mode & 0o777).toBe(0o600);
  });

  it.each(['timeout', 'interrupted'] as const)("persists %s", async termination => {
    const { store, reader } = await setup();
    const handle = runTrackedAgent(options, store, context, () => fake([], Promise.resolve({ exitCode: 1, termination })));
    for await (const _event of handle.events) { /* drain */ }
    await handle.done;
    expect((await reader.list())[0].status).toBe(termination);
  });

  it("archives spawn errors and separate retry attempts without losing the prior attempt", async () => {
    const { store, reader } = await setup();
    expect(() => runTrackedAgent(options, store, context, () => { throw new Error('cannot spawn'); })).toThrow('cannot spawn');
    const handle = runTrackedAgent(options, store, context, () => fake([], Promise.reject(new Error('No conversation found'))));
    for await (const _event of handle.events) { /* drain */ }
    await expect(handle.done).rejects.toThrow('No conversation found');
    const runs = await reader.list();
    expect(runs).toHaveLength(2);
    expect(runs.every(run => run.status === 'failed')).toBe(true);
  });

  it("marks an error result as failed even if the CLI exits zero", async () => {
    const { store, reader } = await setup();
    const handle = runTrackedAgent(options, store, context, () => fake([
      { type: 'result', isError: true, stopReason: 'error', raw: {} },
    ]));
    for await (const _event of handle.events) { /* drain */ }
    await handle.done;
    expect((await reader.list())[0].status).toBe('failed');
  });

  it("does not block agent execution when the archive cannot be written", async () => {
    const { dir } = await setup();
    const file = path.join(dir, 'not-a-directory'); await writeFile(file, 'x');
    const underlying = fake([]);
    expect(runTrackedAgent(options, new HistoryStore(file), context, () => underlying)).toBe(underlying);
  });

  it("redacts common structured credentials and limits oversized records with an explicit marker", async () => {
    const { store, reader, dir } = await setup();
    const trace = store.begin({ ...context, agent: 'codex' })!;
    trace.record({ type: 'tool_started', raw: { api_key: 'super-secret', nested: { password: 'pw-secret' }, authorization: 'Bearer token-secret' } });
    trace.record({ type: 'tool_finished', raw: '中文'.repeat(150000) });
    trace.finish('completed');
    const contents = await readFile(path.join(dir, `${trace.summary.id}.jsonl`), 'utf8');
    expect(contents).not.toContain('super-secret'); expect(contents).not.toContain('pw-secret');
    expect(contents).not.toContain('token-secret');
    expect((await reader.events(trace.summary.id, 0))?.events[1].truncated).toBe(true);
  });

  it("incrementally reads large histories without duplicates or UTF-8 loss, ignoring an incomplete tail", async () => {
    const { store, reader, dir } = await setup();
    const trace = store.begin({ ...context, agent: 'codex' })!;
    for (let i = 0; i < 20; i++) trace.record({ type: 'text_delta', index: i, text: '测'.repeat(30000) });
    let offset = 0, collected: unknown[] = [];
    for (;;) {
      const page = (await reader.events(trace.summary.id, offset))!;
      collected.push(...page.events.map(event => event.index)); offset = page.nextOffset;
      if (!page.hasMore) break;
    }
    expect(collected).toEqual(Array.from({ length: 20 }, (_, i) => i));
    const file = path.join(dir, `${trace.summary.id}.jsonl`);
    await writeFile(file, '{"unfinished":', { flag: 'a' });
    expect(await reader.events(trace.summary.id, offset)).toEqual({ events: [], nextOffset: offset, hasMore: false });
    const [run] = await reader.list();
    await writeFile(path.join(dir, `${run.id}.json`), JSON.stringify({ ...run, pid: 2147483647 }));
    expect((await reader.list())[0].status).toBe('abandoned');
    expect(await reader.events('../secrets', 0)).toBeUndefined();
    expect(await readdir(dir)).toHaveLength(2);
  });
});

describe("local history HTTP viewer", () => {
  it("groups conversation history, supports search, serves incremental events and guards local access", async () => {
    const { store, reader } = await setup();
    const first = store.begin({ ...context, agent: 'claude' })!;
    first.record({ type: 'text_delta', text: '<script>alert(1)</script>' }); first.finish('completed');
    store.begin({ ...context, title: '第二轮', agent: 'claude' })!.finish('failed');
    store.begin({ ...context, platform: 'wechat', agent: 'codex' })!.finish('completed');
    const service = await startHistoryServer(reader, 0); servers.push(service);
    const get = async (url: string) => (await fetch(service.url + url)).json();
    const groups = await get('/api/conversations?platform=feishu&q=构建');
    expect(groups.total).toBe(1); expect(groups.items[0].count).toBe(2);
    expect((await get('/api/runs?platform=feishu&conversation=thread-a')).total).toBe(2);
    expect((await get(`/api/runs/${first.summary.id}/events?offset=0`)).events[0].text).toContain('<script>');
    expect((await fetch(`${service.url}/api/runs/${first.summary.id}/events?offset=-1`)).status).toBe(400);
    expect((await fetch(service.url + '/api/conversations', { headers: { Origin: 'https://evil.test' } })).status).toBe(403);
    expect((await fetch(service.url + '/api/conversations', { method: 'POST' })).status).toBe(405);
    const badHost = await new Promise<number | undefined>(resolve => {
      request(service.url + '/api/conversations', { headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); }).end();
    });
    expect(badHost).toBe(403);
    const page = await fetch(service.url);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain('会话与执行记录');
    expect(await (await fetch(service.url + '/app.js')).text()).not.toContain('innerHTML');
  });
});
