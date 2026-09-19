// 嵌入配置的两组纯函数（从 embeddingConfig.ts 拆出，保单文件行数门禁）：
//   1) apiKey 的 AES-256-GCM 加解密与脱敏（零新依赖，node:crypto）；
//   2) 配置字段的取值白名单校验（非法抛错，由写入层转 400）。
// 纯函数、无 IO、不读库；embeddingConfig.ts 原样再导出，调用方导入路径不变。

import crypto from "node:crypto";
import { DIM_MIN, DIM_MAX } from "./embedding/types.js";

export const DEFAULT_FIELD_CHUNK_CAP = 50;
/** 字段索引上限的硬顶（1..1000）。 */
export const FIELD_CAP_MAX = 1000;

const CIPHER_VERSION = "v1";
/** HKDF 域分隔：固定 salt + info，绑定用途，防同一主密钥派生被跨场景复用。 */
const HKDF_SALT = "gouxiangdb/embedding";
const HKDF_INFO = "embedding-api-key/v1";

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

/** 手动维度门：1..DIM_MAX，或 0（未指定）；越界抛错由写入层转 400。 */
export function validateDimOverride(n: number): number {
  if (n === 0) return 0; // 0 = 清除手填、沿用 model 元数据
  if (!Number.isInteger(n) || n < DIM_MIN || n > DIM_MAX) {
    throw new Error(`dim must be an integer in [${DIM_MIN}, ${DIM_MAX}] or 0, got ${String(n)}`);
  }
  return n;
}

/** 正整数门（batchSize/timeoutMs/concurrency/retry 等）；非法抛错由配置写入层转 400（S9）。 */
export function validatePositiveInt(n: number, max: number, field: string): number {
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`${field} must be a positive integer in [1, ${max}], got ${String(n)}`);
  }
  return n;
}

/**
 * S9 PATCH 校验：http(s) URL 合法且非空白。只校验形态，不做可达性探测（健康由 health() 另算）。
 */
export function validateHttpUrl(raw: string): string {
  const v = raw.trim();
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error("baseURL must be a valid http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseURL must use http or https protocol");
  }
  return v;
}
