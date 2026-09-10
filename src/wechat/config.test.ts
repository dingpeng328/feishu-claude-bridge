import { describe, expect, it } from "vitest";
import { loadWechatConfig } from "./config.js";

describe("loadWechatConfig", () => {
  it("uses a separate state root and ignores Feishu credentials", () => {
    const config = loadWechatConfig({
      HOME: "/should/not/be-used",
      FEISHU_APP_ID: "secret-feishu-value",
      FEISHU_APP_SECRET: "secret-feishu-value",
      WECHAT_STATE_DIR: "/tmp/wechat-state",
      WECHAT_WORK_DIR: "/tmp/wechat-work",
    });
    expect(config.stateDir).toBe("/tmp/wechat-state");
    expect(config.sessionsPath).toBe("/tmp/wechat-state/sessions.json");
    expect(config.workDir).toBe("/tmp/wechat-work");
    expect(config.codexSandbox).toBe("workspace-write");
    expect(config.codexApproveForMe).toBe(true);
    expect(config).not.toHaveProperty("appId");
    expect(config).not.toHaveProperty("appSecret");
  });

  it("parses the independent Codex safety settings", () => {
    const config = loadWechatConfig({
      WECHAT_STATE_DIR: "/tmp/wechat-state",
      WECHAT_CODEX_SANDBOX: "read-only",
      WECHAT_CODEX_APPROVE_FOR_ME: "false",
    });
    expect(config.codexSandbox).toBe("read-only");
    expect(config.codexApproveForMe).toBe(false);
  });

  it("disables automatic approval for a read-only sandbox", () => {
    const config = loadWechatConfig({
      WECHAT_STATE_DIR: "/tmp/wechat-state",
      WECHAT_CODEX_SANDBOX: "read-only",
    });
    expect(config.codexApproveForMe).toBe(false);
  });
});
