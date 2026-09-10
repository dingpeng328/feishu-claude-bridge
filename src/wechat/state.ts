import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WechatCredentials {
  accountId: string;
  userId: string;
  token: string;
  baseUrl: string;
  connectedAt: number;
}

interface DeliveryFile {
  cursor: string;
  processedMessageIds: string[];
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(tmpPath, 0o600);
  await rename(tmpPath, filePath);
  await chmod(filePath, 0o600);
}

export class WechatCredentialStore {
  constructor(readonly filePath: string) {}

  async load(): Promise<WechatCredentials | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const parsed = JSON.parse(raw) as Partial<WechatCredentials>;
    if (
      typeof parsed.accountId !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.token !== "string" ||
      typeof parsed.baseUrl !== "string" ||
      typeof parsed.connectedAt !== "number"
    ) {
      throw new Error(`微信凭证文件格式无效：${this.filePath}`);
    }
    await chmod(this.filePath, 0o600);
    return parsed as WechatCredentials;
  }

  async save(credentials: WechatCredentials): Promise<void> {
    await writePrivateJson(this.filePath, credentials);
  }
}

export class WechatDeliveryState {
  readonly #filePath: string;
  readonly #processed: Set<string>;
  #cursor: string;

  private constructor(filePath: string, file: DeliveryFile) {
    this.#filePath = filePath;
    this.#cursor = file.cursor;
    this.#processed = new Set(file.processedMessageIds);
  }

  static async load(filePath: string): Promise<WechatDeliveryState> {
    let file: DeliveryFile = { cursor: "", processedMessageIds: [] };
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<DeliveryFile>;
      file = {
        cursor: typeof parsed.cursor === "string" ? parsed.cursor : "",
        processedMessageIds: Array.isArray(parsed.processedMessageIds)
          ? parsed.processedMessageIds.filter((value): value is string => typeof value === "string")
          : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const state = new WechatDeliveryState(filePath, file);
    await state.flush();
    return state;
  }

  get cursor(): string {
    return this.#cursor;
  }

  has(messageId: string): boolean {
    return this.#processed.has(messageId);
  }

  async commit(messageId: string | undefined, cursor: string | undefined): Promise<void> {
    if (messageId) {
      this.#processed.delete(messageId);
      this.#processed.add(messageId);
      while (this.#processed.size > 2_000) {
        const oldest = this.#processed.values().next().value as string | undefined;
        if (!oldest) break;
        this.#processed.delete(oldest);
      }
    }
    if (cursor) this.#cursor = cursor;
    await this.flush();
  }

  async flush(): Promise<void> {
    await writePrivateJson(this.#filePath, {
      cursor: this.#cursor,
      processedMessageIds: [...this.#processed],
    } satisfies DeliveryFile);
  }
}
