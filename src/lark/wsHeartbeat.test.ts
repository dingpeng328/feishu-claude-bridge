import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";

interface TestWsClient {
  wsConfig: {
    updateWs(value: Record<string, unknown>): void;
    setWSInstance(value: unknown): void;
  };
  pingLoop(): void;
  handleControlData(data: unknown): Promise<void>;
  sendMessage: ReturnType<typeof vi.fn>;
  pongTimeout?: ReturnType<typeof setTimeout>;
  lastPongAt: number;
  close(params?: { force?: boolean }): void;
}

function makeClient() {
  const client = new WSClient({
    appId: "test-app",
    appSecret: "test-secret",
    loggerLevel: LoggerLevel.error,
  }) as unknown as TestWsClient;
  const ws = {
    readyState: 1, // ws.OPEN
    terminate: vi.fn(function (this: { readyState: number }) {
      this.readyState = 3;
    }),
    removeAllListeners: vi.fn(),
    close: vi.fn(),
  };
  client.wsConfig.updateWs({ serviceId: "1", pingInterval: 120_000 });
  client.wsConfig.setWSInstance(ws);
  client.sendMessage = vi.fn();
  return { client, ws };
}

describe("vendored Feishu WS heartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends an application ping every 30 seconds", () => {
    const { client } = makeClient();
    client.pingLoop();
    expect(client.sendMessage).toHaveBeenCalledTimes(1);

    // Pretend the first pong arrived so its timeout does not terminate the fake socket.
    clearTimeout(client.pongTimeout);
    client.pongTimeout = undefined;
    vi.advanceTimersByTime(29_999);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
    client.close({ force: true });
  });

  it("terminates an OPEN socket when pong is absent for 15 seconds", () => {
    const { client, ws } = makeClient();
    client.pingLoop();
    vi.advanceTimersByTime(14_999);
    expect(ws.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ws.terminate).toHaveBeenCalledOnce();
    client.close({ force: true });
  });

  it("clears the timeout when pong arrives", async () => {
    const { client, ws } = makeClient();
    client.pingLoop();
    const before = client.lastPongAt;

    await client.handleControlData({
      headers: [{ key: "type", value: "pong" }],
      payload: new TextEncoder().encode(JSON.stringify({
        PingInterval: 120,
        ReconnectCount: -1,
        ReconnectInterval: 120,
        ReconnectNonce: 30,
      })),
    });

    expect(client.lastPongAt).toBeGreaterThanOrEqual(before);
    expect(client.pongTimeout).toBeUndefined();
    vi.advanceTimersByTime(15_000);
    expect(ws.terminate).not.toHaveBeenCalled();
    client.close({ force: true });
  });
});
