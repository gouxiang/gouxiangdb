// M5/S4 embedding 配置与凭据：env 只读种子 + app_settings 持久化 + API key AES-256-GCM。
//
// 权威依据：M5-implementation-plan §4.4（配置表/凭据存储/脱敏视图）、§5.4（PATCH 落 app_settings，
// reindex 执行在 S5/S9，本片只写配置面）。
//
// 边界：
//   - app_settings 是【主库】Prisma 表（AppSetting model）；与 search.db 无关，本片不碰 searchStore。
//   - env 仅作首启只读种子；管理员 PATCH 覆盖值落 app_settings（db 优先于 env）。
//   - apiKey 落库必须加密：node:crypto（零新依赖）。数据密钥从 config.jwtSecret 经 HKDF-SHA256
//     派生（绝不把 jwtSecret 当 AES key 裸用）；每密文随机 IV + GCM authTag；存储版本化 v1。
//   - JWT_SECRET 变更导致解密失败：回落到 configured:false，绝不 500（§4.4 验收）。

import crypto from "node:crypto";
import type { EmbeddingMode } from "./embedding/types.js";
import {
  parseEmbeddingMode,
  DEFAULT_BATCH_SIZE,
  DEFAULT_TIMEOUT_MS,
} from "./embedding/types.js";

// ---- app_settings 键（命名空间前缀，避免与未来 KV 混用）----
export const SETTING_KEYS = {
  mode: "embedding.mode",
  baseUrl: "embedding.base_url",
  apiKeyCipher: "embedding.api_key_cipher",
  model: "embedding.model",
  batchSize: "embedding.batch_size",
  timeoutMs: "embedding.timeout_ms",
  fieldChunkCap: "search.field_chunk_cap",
} as const;

export const DEFAULT_FIELD_CHUNK_CAP = 50;
const FIELD_CAP_MAX = 1000;
const CIPHER_VERSION = "v1";
/** HKDF 域分隔：固定 salt + info，绑定用途，防同一主密钥派生被跨场景复用。 */
const HKDF_SALT = "gouxiangdb/embedding";
const HKDF_INFO = "embedding-api-key/v1";

/**
 * Prisma AppSetting 访问面（最小结构；只声明本片实际用到的三个方法）。
 * 真实 Prisma 客户端可结构化赋值（harness 直接传 h.prisma），不静态绑 db 单例。
 */
export interface AppSettingClient {
  appSetting: {
    findUnique(args: { where: { k: string } }): Promise<{ k: string; v: string } | null>;
    upsert(args: {
      where: { k: string };
      create: { k: string; v: string };
      update: { v: string };
    }): Promise<unknown>;
    delete(args: { where: { k: string } }): Promise<unknown>;
  };
}

// ============================ 纯函数：env 种子 ============================

export interface EnvEmbeddingSeed {
  mode: EmbeddingMode;
  baseURL: string;
  apiKey: string;
  model: string;
  batchSize: number;
  timeoutMs: number;
  fieldChunkCap: number;
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) return fallback;
  return n;
}

/** 从 process.env 形状的对象读首启种子（只读、不写库）。未知 mode 回 off。 */
export function readEnvEmbeddingSeed(env: NodeJS.ProcessEnv): EnvEmbeddingSeed {
  return {
    mode: parseEmbeddingMode(env.GX_EMBEDDING_MODE),
    baseURL: env.GX_EMBEDDING_BASE_URL?.trim() ?? "",
    apiKey: env.GX_EMBEDDING_API_KEY?.trim() ?? "",
    model: env.GX_EMBEDDING_MODEL?.trim() ?? "",
    batchSize: positiveInt(env.GX_EMBEDDING_BATCH_SIZE, DEFAULT_BATCH_SIZE, 10000),
    timeoutMs: positiveInt(env.GX_EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 600000),
    fieldChunkCap: positiveInt(env.GX_SEARCH_FIELD_CHUNK_CAP, DEFAULT_FIELD_CHUNK_CAP, FIELD_CAP_MAX),
  };
}

// ======================= 纯函数：AES-256-GCM 加解密 =======================

/** 从主密钥（jwtSecret）HKDF-SHA256 派生 32 字节 AES-256 数据密钥。 */
export function deriveDataKey(masterSecret: string): Buffer {
  if (!masterSecret) throw new Error("cannot derive embedding data key from empty master secret");
  return Buffer.from(crypto.hkdfSync("sha256", masterSecret, HKDF_SALT, HKDF_INFO, 32));
}

/** 加密：随机 12 字节 IV + GCM authTag，输出版本化字符串 v1:ivB64:tagB64:ctB64。 */
export function encryptSecret(plaintext: string, masterSecret: string): string {
  const key = deriveDataKey(masterSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CIPHER_VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/** 解密：校验版本与 GCM authTag；任何篡改/密钥不符/格式错都抛错（调用方决定回落，不吞成空串）。 */
export function decryptSecret(stored: string, masterSecret: string): string {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) {
    throw new Error("unsupported or malformed embedding ciphertext");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = deriveDataKey(masterSecret);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]);
  return plain.toString("utf8");
}

/** 脱敏：仅回末 4 字符，其余固定掩码；过短串不泄露任何原文。 */
export function maskApiKey(plaintext: string): string {
  const t = plaintext.trim();
  if (t.length < 4) return "****";
  return `****${t.slice(-4)}`;
}

/** fieldChunkCap 正整数门（1..1000）；非法抛错由配置写入层转 400（S9）。 */
export function validateFieldChunkCap(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > FIELD_CAP_MAX) {
    throw new Error(`fieldChunkCap must be an integer in [1, ${FIELD_CAP_MAX}], got ${String(n)}`);
  }
  return n;
}

// ===================== app_settings 持久化（主库 Prisma） =======================

export interface EmbeddingConfigView {
  mode: EmbeddingMode;
  baseURL: string;
  model: string;
  batchSize: number;
  timeoutMs: number;
  fieldChunkCap: number;
  /** key 是否可用：db 密文可解或 env 提供了非空 key。 */
  hasKey: boolean;
  /** key 来源：db 密文优先；否则 env；都无则 none。 */
  keySource: "db" | "env" | "none";
  maskedKey: string | null;
  /** db 密文存在但解密失败（如 JWT_SECRET 轮换）：hasKey=false 且不 500。 */
  dbKeyUndecryptable: boolean;
}

/** 主库配置存储：db 覆盖 env；apiKey 加密落库、脱敏读取。 */
export class EmbeddingConfigStore {
  constructor(
    private readonly client: AppSettingClient,
    private readonly masterSecret: string,
  ) {}

  private async getRaw(k: string): Promise<string | undefined> {
    return (await this.client.appSetting.findUnique({ where: { k } }))?.v;
  }

  private async setRaw(k: string, v: string): Promise<void> {
    await this.client.appSetting.upsert({ where: { k }, create: { k, v }, update: { v } });
  }

  async setMode(mode: EmbeddingMode): Promise<void> { await this.setRaw(SETTING_KEYS.mode, mode); }
  async setBaseUrl(v: string): Promise<void> { await this.setRaw(SETTING_KEYS.baseUrl, v.trim()); }
  async setModel(v: string): Promise<void> { await this.setRaw(SETTING_KEYS.model, v.trim()); }
  async setBatchSize(n: number): Promise<void> { await this.setRaw(SETTING_KEYS.batchSize, String(n)); }
  async setFieldChunkCap(n: number): Promise<void> {
    await this.setRaw(SETTING_KEYS.fieldChunkCap, String(validateFieldChunkCap(n)));
  }

  /** API key 加密落库（绝不明文写 app_settings）。空串等价清除。 */
  async setApiKey(plaintext: string): Promise<void> {
    const t = plaintext.trim();
    if (!t) { await this.deleteApiKey(); return; }
    await this.setRaw(SETTING_KEYS.apiKeyCipher, encryptSecret(t, this.masterSecret));
  }

  async deleteApiKey(): Promise<void> {
    await this.client.appSetting.delete({ where: { k: SETTING_KEYS.apiKeyCipher } }).catch(() => undefined);
  }

  /** 解密 db key；失败抛错（调用方在视图层回落，写入校验场景需要显式失败）。 */
  async getApiKey(): Promise<string | null> {
    const cipher = await this.getRaw(SETTING_KEYS.apiKeyCipher);
    if (!cipher) return null;
    return decryptSecret(cipher, this.masterSecret);
  }

  /**
   * 合并 env 种子与 db 覆盖，产出脱敏配置视图（绝不回明文 key）。
   * db 密文解密失败 -> hasKey=false/dbKeyUndecryptable=true/keySource 按 env 判定，不抛错。
   */
  async resolveView(env: NodeJS.ProcessEnv): Promise<EmbeddingConfigView> {
    const seed = readEnvEmbeddingSeed(env);
    const dbMode = await this.getRaw(SETTING_KEYS.mode) as EmbeddingMode | undefined;
    const mode = dbMode === "cloud" || dbMode === "off" ? dbMode : seed.mode;
    const baseURL = (await this.getRaw(SETTING_KEYS.baseUrl)) ?? seed.baseURL;
    const model = (await this.getRaw(SETTING_KEYS.model)) ?? seed.model;
    const batchSize = positiveInt(await this.getRaw(SETTING_KEYS.batchSize), seed.batchSize, 10000);
    const timeoutMs = positiveInt(await this.getRaw(SETTING_KEYS.timeoutMs), seed.timeoutMs, 600000);
    const fieldChunkCap = positiveInt(await this.getRaw(SETTING_KEYS.fieldChunkCap), seed.fieldChunkCap, FIELD_CAP_MAX);

    const cipher = await this.getRaw(SETTING_KEYS.apiKeyCipher);
    let hasKey = false;
    let keySource: EmbeddingConfigView["keySource"] = "none";
    let maskedKey: string | null = null;
    let dbKeyUndecryptable = false;
    if (cipher) {
      try {
        const plain = decryptSecret(cipher, this.masterSecret);
        hasKey = plain.length > 0;
        if (hasKey) { keySource = "db"; maskedKey = maskApiKey(plain); }
      } catch {
        // JWT_SECRET 轮换/篡改：降级为不可用，交 status 提示重新配置，绝不 500。
        dbKeyUndecryptable = true;
      }
    }
    if (!hasKey && seed.apiKey) {
      hasKey = true;
      keySource = "env";
      maskedKey = maskApiKey(seed.apiKey);
    }
    return { mode, baseURL, model, batchSize, timeoutMs, fieldChunkCap, hasKey, keySource, maskedKey, dbKeyUndecryptable };
  }
}
