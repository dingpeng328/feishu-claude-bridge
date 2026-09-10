import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { WechatConfig } from "./config.js";
import {
  WECHAT_FIXED_LOGIN_BASE_URL,
  WechatProtocolClient,
  type QrStatusResponse,
} from "./protocol.js";
import { WechatCredentialStore, type WechatCredentials } from "./state.js";

const LOGIN_TIMEOUT_MS = 8 * 60_000;
const MAX_QR_REFRESHES = 3;

async function displayQrCode(url: string): Promise<void> {
  try {
    const qrcode = await import("qrcode-terminal");
    qrcode.default.generate(url, { small: true });
  } catch {
    console.warn("[wechat-auth] 终端二维码渲染失败，请打开下方链接完成连接。");
  }
  process.stdout.write(`\n若二维码无法扫描，请打开：\n${url}\n\n`);
}

async function readVerifyCode(): Promise<string> {
  if (!stdin.isTTY) {
    throw new Error("微信要求输入手机上的配对码；请在前台终端运行登录，不能通过无交互的后台进程完成。");
  }
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return (await readline.question("请输入手机微信显示的数字配对码：")).trim();
  } finally {
    readline.close();
  }
}

function validateConfirmed(
  response: QrStatusResponse,
  fallbackBaseUrl: string,
): WechatCredentials {
  const accountId = response.ilink_bot_id?.trim();
  const userId = response.ilink_user_id?.trim();
  const token = response.bot_token?.trim();
  if (!accountId || !userId || !token) {
    throw new Error("微信已确认扫码，但服务端没有返回完整的 bot id、user id 和 token。");
  }
  return {
    accountId,
    userId,
    token,
    baseUrl: response.baseurl?.trim() || fallbackBaseUrl,
    connectedAt: Date.now(),
  };
}

function validateQrResponse(value: { qrcode?: string; qrcode_img_content?: string }): {
  qrcode: string;
  qrcode_img_content: string;
} {
  if (!value.qrcode?.trim() || !value.qrcode_img_content?.trim()) {
    throw new Error("微信服务端没有返回完整的二维码信息。");
  }
  return { qrcode: value.qrcode, qrcode_img_content: value.qrcode_img_content };
}

/** Load existing credentials, or perform the official ClawBot QR login flow. */
export async function ensureWechatCredentials(options: {
  config: WechatConfig;
  store: WechatCredentialStore;
  forceLogin?: boolean;
}): Promise<WechatCredentials> {
  const existing = await options.store.load();
  if (existing && options.forceLogin !== true) return existing;

  console.log("[wechat-auth] 需要连接微信，请使用手机微信扫描二维码。");
  let qrClient = new WechatProtocolClient({
    baseUrl: WECHAT_FIXED_LOGIN_BASE_URL,
    botAgent: options.config.botAgent,
  });
  let effectivePollingBaseUrl = WECHAT_FIXED_LOGIN_BASE_URL;
  let qr = validateQrResponse(
    await qrClient.fetchQrCode(
      options.config.botType,
      existing?.token ? [existing.token] : [],
    ),
  );
  let refreshes = 0;
  let verifyCode: string | undefined;
  let scannedPrinted = false;
  await displayQrCode(qr.qrcode_img_content);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let response: QrStatusResponse;
    try {
      response = await qrClient.pollQrStatus(qr.qrcode, verifyCode);
    } catch (err) {
      console.warn(`[wechat-auth] 查询扫码状态失败，将继续重试：${String(err)}`);
      continue;
    }

    switch (response.status) {
      case "wait":
        break;
      case "scaned":
        verifyCode = undefined;
        if (!scannedPrinted) {
          console.log("[wechat-auth] 已扫码，正在等待手机确认…");
          scannedPrinted = true;
        }
        break;
      case "need_verifycode":
        verifyCode = await readVerifyCode();
        continue;
      case "scaned_but_redirect":
        if (response.redirect_host?.trim()) {
          effectivePollingBaseUrl = `https://${response.redirect_host.trim()}`;
          qrClient = new WechatProtocolClient({
            baseUrl: effectivePollingBaseUrl,
            botAgent: options.config.botAgent,
          });
        }
        break;
      case "confirmed": {
        const fallbackBaseUrl =
          effectivePollingBaseUrl === WECHAT_FIXED_LOGIN_BASE_URL
            ? options.config.apiBaseUrl
            : effectivePollingBaseUrl;
        const credentials = validateConfirmed(response, fallbackBaseUrl);
        await options.store.save(credentials);
        console.log(`[wechat-auth] 微信连接成功，账号 ${credentials.accountId}。`);
        return credentials;
      }
      case "binded_redirect":
        if (existing) {
          console.log("[wechat-auth] 微信提示该机器人已经连接，继续使用本地已有凭证。");
          return existing;
        }
        throw new Error("微信提示机器人已经连接，但本机没有可复用凭证；请解除旧连接后重新扫码。");
      case "expired":
      case "verify_code_blocked":
        refreshes++;
        if (refreshes >= MAX_QR_REFRESHES) {
          throw new Error("二维码已连续失效或配对码错误次数过多，请稍后重新运行登录。");
        }
        console.log(`[wechat-auth] 二维码需要刷新（${refreshes}/${MAX_QR_REFRESHES}）。`);
        qrClient = new WechatProtocolClient({
          baseUrl: WECHAT_FIXED_LOGIN_BASE_URL,
          botAgent: options.config.botAgent,
        });
        effectivePollingBaseUrl = WECHAT_FIXED_LOGIN_BASE_URL;
        qr = validateQrResponse(
          await qrClient.fetchQrCode(
            options.config.botType,
            existing?.token ? [existing.token] : [],
          ),
        );
        verifyCode = undefined;
        scannedPrinted = false;
        await displayQrCode(qr.qrcode_img_content);
        break;
      default:
        throw new Error(`未知的微信扫码状态：${String(response.status)}`);
    }
  }
  throw new Error("等待微信扫码确认超时，请重新运行登录。");
}
