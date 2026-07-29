import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { formatWithOptions } from "node:util";

let installed = false;

function redactSecrets(value: string): string {
  return value
    .replace(/(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[^\s,"'}]+/gi, "$1<redacted>")
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer <redacted>")
    .replace(/((?:app[_-]?secret|access[_-]?token|cookie)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1<redacted>");
}

/** Mirror timestamped console output into a durable append-only runtime log. */
export function installPersistentLogging(logPath: string): void {
  if (installed) return;
  installed = true;
  mkdirSync(dirname(logPath), { recursive: true });

  for (const method of ["log", "warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const prefix = `[${new Date().toLocaleString()}]`;
      original(prefix, ...args);
      try {
        const rendered = redactSecrets(formatWithOptions({ colors: false, depth: 6 }, ...args));
        appendFileSync(logPath, `${prefix} ${rendered}\n`, "utf8");
      } catch (err) {
        original(prefix, `[logger] failed to append ${logPath}:`, err);
      }
    };
  }
}

export { redactSecrets as _redactSecrets };
