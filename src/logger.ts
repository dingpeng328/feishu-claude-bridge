import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { formatWithOptions } from "node:util";

let installed = false;

function redactSecrets(value: string): string {
  return value
    .replace(/(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[^\s,"'}]+/gi, "$1<redacted>")
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer <redacted>")
    .replace(
      /((?:\b[\w]+[_-])?(?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|bot[_-]?token|context[_-]?token|password|passwd|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,"'}]+)/gi,
      '$1"<redacted>"',
    );
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
      const rendered = redactSecrets(formatWithOptions({ colors: false, depth: 6 }, ...args));
      // Foreground output can also be redirected or collected by a supervisor.
      // Apply the same redaction before either output leaves this process.
      original(prefix, rendered);
      try {
        appendFileSync(logPath, `${prefix} ${rendered}\n`, "utf8");
      } catch (err) {
        original(prefix, `[logger] failed to append ${logPath}:`, err);
      }
    };
  }
}

export { redactSecrets as _redactSecrets };
