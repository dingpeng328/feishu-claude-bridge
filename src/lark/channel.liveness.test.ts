import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ChannelClient } from "./channel.js";

vi.mock("@larksuite/channel", () => ({
  createLarkChannel: () => ({
    on: vi.fn(),
    connect: async () => undefined,
    disconnect: async () => undefined,
  }),
}));

const execFileAsync = promisify(execFile);

// A fake-clock test cannot detect Node exiting with a pending Promise and only
// unref'ed timers. Run the actual retry scheduler in an otherwise idle process.
async function runIsolated(action: string): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e", `
      import { ChannelClient } from "./src/lark/channel.ts";
      const client = new ChannelClient({
        appId: "test", appSecret: "test", allowedChatIds: new Set(),
        deliveryStatePath: "/unused-liveness-test",
      });
      // No network, disk writes, or auxiliary timers may keep this child alive.
      client.deliveryState = { close: async () => undefined };
      client.journal = { close: async () => undefined };
      let attempts = 0;
      client.connectChannel = async () => {
        console.log("ATTEMPT", ++attempts);
        if (attempts <= 2) throw new Error("simulated network outage");
        console.log("RECOVERED");
        await client.close();
      };
      void (async () => { ${action} })().catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
    `,
  ], { cwd: new URL("../../", import.meta.url), timeout: 10_000 });
  return stdout;
}

describe("channel process liveness", () => {
  it.each(["connect", "rebuildChannel"])(
    "survives repeated network failures during %s until recovery",
    async method => {
      const output = await runIsolated(`await client.${method}();`);
      expect(output).toContain("ATTEMPT 3");
      expect(output).toContain("RECOVERED");
    },
    12_000,
  );

  it("cancels a scheduled reconnect on shutdown and lets the process exit", async () => {
    const output = await runIsolated(`
      await client.connect();
      await client.close();
      console.log("CLOSED");
    `);
    expect(output).toContain("CLOSED");
    expect(output).not.toContain("ATTEMPT 2");
  });

  it("keeps the watchdog alive without socket handles and releases it on close", async () => {
    const client = new ChannelClient({
      appId: "test", appSecret: "test", allowedChatIds: new Set(),
      deliveryStatePath: "/unused-liveness-test", catchUpIntervalMs: 0,
    });
    const internal = client as unknown as {
      connectChannel(): Promise<void>;
      staleTimer: NodeJS.Timeout | null;
    };
    try {
      await internal.connectChannel();
      expect(internal.staleTimer?.hasRef()).toBe(true);
    } finally {
      await client.close();
    }
    expect(internal.staleTimer).toBeNull();
  });
});
