import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { HistoryReader } from "./store.js";

export async function startHistoryServer(reader: HistoryReader, port = 8765) {
  const assets = new Map(await Promise.all([
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/style.css", "style.css", "text/css; charset=utf-8"],
  ].map(async ([url, file, mime]) => [url, { mime, body: await readFile(new URL(`./public/${file}`, import.meta.url)) }] as const)));
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const address = server.address();
      const actualPort = address && typeof address === "object" ? address.port : port;
      const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!hosts.includes(req.headers.host ?? "") ||
        (req.headers.origin && !hosts.some(host => req.headers.origin === `http://${host}`)) ||
        (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))) {
        json(403, { error: "仅允许从本地页面访问" }); return;
      }
      if (req.method !== "GET") { json(405, { error: "只支持读取" }); return; }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const asset = assets.get(url.pathname);
      if (asset) { res.writeHead(200, { "Content-Type": asset.mime }); res.end(asset.body); return; }
      if (url.pathname === "/api/conversations" || url.pathname === "/api/runs") {
        const runs = await reader.list();
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const platform = url.searchParams.get("platform");
        const conversation = url.searchParams.get("conversation");
        const offset = integer(url.searchParams.get("offset"), 0);
        const filtered = runs.filter(run => (!platform || run.platform === platform) &&
          (!conversation || run.conversationId === conversation));
        if (url.pathname === "/api/runs") {
          json(200, { items: filtered.slice(offset, offset + 50), total: filtered.length }); return;
        }
        const groups = new Map<string, { conversationId: string; platform: string; title: string;
          startedAt: number; status: string; count: number; matches: boolean }>();
        for (const run of filtered) {
          const key = `${run.platform}:${run.conversationId}`;
          let group = groups.get(key);
          if (!group) {
            group = { conversationId: run.conversationId, platform: run.platform, title: run.title,
              startedAt: run.startedAt, status: run.status, count: 0, matches: false };
            groups.set(key, group);
          }
          group.count++;
          group.matches ||= `${run.title} ${run.conversationId} ${run.sessionId ?? ""}`.toLowerCase().includes(q);
          if (run.status === "running") group.status = "running";
        }
        const items = [...groups.values()].filter(group => group.matches);
        json(200, { items: items.slice(offset, offset + 50), total: items.length }); return;
      }
      const match = /^\/api\/runs\/([a-f0-9-]{36})\/events$/.exec(url.pathname);
      if (match) {
        const result = await reader.events(match[1], integer(url.searchParams.get("offset"), 0));
        json(result ? 200 : 404, result ?? { error: "记录不存在" }); return;
      }
      json(404, { error: "页面不存在" });
    } catch (err) {
      if (err instanceof RangeError || (err instanceof Error && err.message === "Invalid event offset")) {
        json(400, { error: "无效的分页位置" });
      } else {
        console.error("[history] 读取失败：", err);
        json(500, { error: "无法读取历史记录，请查看终端日志" });
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  return { server, url: `http://127.0.0.1:${actualPort}` };
}
function integer(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError("invalid offset");
  return result;
}
