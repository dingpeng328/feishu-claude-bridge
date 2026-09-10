import { randomBytes, randomUUID } from "node:crypto";

/**
 * Minimal client for the Tencent ClawBot iLink protocol.
 * Wire shapes follow https://github.com/Tencent/openclaw-weixin/tree/main/src/api
 * (MIT). Keep the protocol version pinned and revalidate it when upgrading.
 */
export const WECHAT_PROTOCOL_VERSION = "2.4.9";
export const WECHAT_FIXED_LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";

export const WechatMessageType = { USER: 1, BOT: 2 } as const;
export const WechatMessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const WechatItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;

export interface WechatMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string };
}

export interface WechatMessage {
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WechatMessageItem[];
  context_token?: string;
  run_id?: string;
  create_time_ms?: number;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface QrStatusResponse {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
}

interface ProtocolOptions {
  baseUrl: string;
  token?: string;
  botAgent: string;
}

const LOSSLESS_ID_FIELDS = new Set(["message_id", "msg_id", "svr_id"]);

/** Preserve uint64 IDs that exceed JavaScript's safe integer range. */
export function parseWechatJson<T>(rawText: string): T {
  let output = "";
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }
    const stringStart = index++;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') break;
    }
    const token = rawText.slice(stringStart, index);
    output += token;
    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? "")) cursor++;
    if (rawText[cursor] !== ":") continue;
    let key: unknown;
    try {
      key = JSON.parse(token);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;
    output += rawText.slice(index, cursor + 1);
    cursor++;
    while (/\s/.test(rawText[cursor] ?? "")) output += rawText[cursor++];
    const numberStart = cursor;
    if (rawText[cursor] === "-") cursor++;
    while (/\d/.test(rawText[cursor] ?? "")) cursor++;
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === "-")) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output) as T;
}

export function extractWechatText(message: WechatMessage): string {
  const parts: string[] = [];
  for (const item of message.item_list ?? []) {
    if (item.type === WechatItemType.TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === WechatItemType.VOICE && item.voice_item?.text) {
      parts.push(item.voice_item.text);
    }
  }
  return parts.join("\n").trim();
}

export function getWechatMessageId(message: WechatMessage): string | undefined {
  if (message.message_id?.trim()) return message.message_id.trim();
  for (const item of message.item_list ?? []) {
    if (item.msg_id?.trim()) return item.msg_id.trim();
  }
  return message.client_id?.trim() || undefined;
}

export function getWechatConversationId(message: WechatMessage): string {
  return message.group_id?.trim() || message.session_id?.trim() || message.from_user_id?.trim() || "unknown";
}

function clientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((value) => Number.parseInt(value, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomWechatUin(): string {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64");
}

function safeBotAgent(value: string): string {
  const ascii = value.replace(/[^\x20-\x7e]/g, "").trim();
  return Buffer.byteLength(ascii, "utf8") <= 256 && ascii ? ascii : "WechatCodexBridge/0.1.0";
}

export class WechatProtocolClient {
  readonly #baseUrl: string;
  readonly #token?: string;
  readonly #botAgent: string;

  constructor(options: ProtocolOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token?.trim() || undefined;
    this.#botAgent = safeBotAgent(options.botAgent);
  }

  baseInfo(): { channel_version: string; bot_agent: string } {
    return { channel_version: WECHAT_PROTOCOL_VERSION, bot_agent: this.#botAgent };
  }

  async fetchQrCode(botType: string, localTokens: string[] = []): Promise<{ qrcode: string; qrcode_img_content: string }> {
    return this.post("ilink/bot/get_bot_qrcode?bot_type=" + encodeURIComponent(botType), {
      local_token_list: localTokens.slice(0, 10),
    }, { timeoutMs: 15_000 });
  }

  async pollQrStatus(qrcode: string, verifyCode?: string): Promise<QrStatusResponse> {
    let endpoint = "ilink/bot/get_qrcode_status?qrcode=" + encodeURIComponent(qrcode);
    if (verifyCode) endpoint += "&verify_code=" + encodeURIComponent(verifyCode);
    return this.get(endpoint, 35_000);
  }

  async getUpdates(cursor: string, timeoutMs: number, signal?: AbortSignal): Promise<GetUpdatesResponse> {
    try {
      return await this.post(
        "ilink/bot/getupdates",
        { get_updates_buf: cursor, base_info: this.baseInfo() },
        { timeoutMs, signal },
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ret: 0, msgs: [], get_updates_buf: cursor };
      }
      throw err;
    }
  }

  async sendText(params: {
    to: string;
    text: string;
    contextToken?: string;
    runId?: string;
  }): Promise<void> {
    const response = await this.post<{ ret?: number; errmsg?: string }>("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: params.to,
        client_id: `wechat-codex-${randomUUID()}`,
        message_type: WechatMessageType.BOT,
        message_state: WechatMessageState.FINISH,
        item_list: [{ type: WechatItemType.TEXT, text_item: { text: params.text } }],
        context_token: params.contextToken,
        run_id: params.runId,
      },
      base_info: this.baseInfo(),
    }, { timeoutMs: 15_000 });
    if (response.ret !== undefined && response.ret !== 0) {
      throw new Error(`微信发送失败：ret=${response.ret} ${response.errmsg ?? ""}`.trim());
    }
  }

  async getTypingTicket(userId: string, contextToken?: string): Promise<string | undefined> {
    const response = await this.post<{ ret?: number; typing_ticket?: string }>("ilink/bot/getconfig", {
      ilink_user_id: userId,
      context_token: contextToken,
      base_info: this.baseInfo(),
    }, { timeoutMs: 10_000 });
    return response.ret === 0 ? response.typing_ticket : undefined;
  }

  async sendTyping(userId: string, ticket: string, typing: boolean): Promise<void> {
    const response = await this.post<{ ret?: number; errmsg?: string }>("ilink/bot/sendtyping", {
      ilink_user_id: userId,
      typing_ticket: ticket,
      status: typing ? 1 : 2,
      base_info: this.baseInfo(),
    }, { timeoutMs: 10_000 });
    this.assertSuccess("sendtyping", response);
  }

  async notifyStarted(): Promise<void> {
    const response = await this.post<{ ret?: number; errmsg?: string }>(
      "ilink/bot/msg/notifystart",
      { base_info: this.baseInfo() },
      { timeoutMs: 10_000 },
    );
    this.assertSuccess("notifystart", response);
  }

  async notifyStopped(): Promise<void> {
    const response = await this.post<{ ret?: number; errmsg?: string }>(
      "ilink/bot/msg/notifystop",
      { base_info: this.baseInfo() },
      { timeoutMs: 10_000 },
    );
    this.assertSuccess("notifystop", response);
  }

  private assertSuccess(operation: string, response: { ret?: number; errmsg?: string }): void {
    if (response.ret !== undefined && response.ret !== 0) {
      throw new Error(`微信 ${operation} 失败：ret=${response.ret} ${response.errmsg ?? ""}`.trim());
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin(),
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(clientVersion(WECHAT_PROTOCOL_VERSION)),
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    return headers;
  }

  private commonHeaders(): Record<string, string> {
    return {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(clientVersion(WECHAT_PROTOCOL_VERSION)),
    };
  }

  private async get<T>(endpoint: string, timeoutMs: number): Promise<T> {
    return this.request<T>(endpoint, { method: "GET", headers: this.commonHeaders() }, timeoutMs);
  }

  private async post<T = Record<string, unknown>>(
    endpoint: string,
    body: unknown,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<T> {
    return this.request<T>(
      endpoint,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      options.timeoutMs,
      options.signal,
    );
  }

  private async request<T>(
    endpoint: string,
    init: RequestInit,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(new URL(endpoint, `${this.#baseUrl}/`), {
        ...init,
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`微信接口 ${endpoint} 返回 HTTP ${response.status}`);
      return parseWechatJson<T>(raw);
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onAbort);
    }
  }
}
