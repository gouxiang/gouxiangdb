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

import type { EmbeddingProviderKind, SearchEnabledOverride } from "@gx/shared-types";
import type { EmbeddingMode } from "./embedding/types.js";
import {
  parseEmbeddingMode,
  parseEmbeddingProvider,
  DEFAULT_BATCH_SIZE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_RETRY_BASE_MS,
  DIM_MAX,
  CONCURRENCY_MAX,
  RETRY_MAX_ATTEMPTS,
  MAX_ATTEMPTS,
} from "./embedding/types.js";

// ---- app_settings 键（命名空间前缀，避免与未来 KV 混用）----
export const SETTING_KEYS = {
  mode: "embedding.mode",
  provider: "embedding.provider",
  baseUrl: "embedding.base_url",
  apiKeyCipher: "embedding.api_key_cipher",
  model: "embedding.model",
  batchSize: "embedding.batch_size",
  timeoutMs: "embedding.timeout_ms",
  /** 手动指定维度（0/缺省=沿用 model 元数据）；仅自建/兼容档可写。 */
  dim: "embedding.dim",
  /** 单批在飞远端请求并发上限。 */
  concurrency: "embedding.concurrency",
  /** 单请求最大尝试次数（首次 + 退避重试）。 */
  retryMaxAttempts: "embedding.retry_max_attempts",
  /** 退避基数（毫秒）。 */
  retryBaseMs: "embedding.retry_base_ms",
  fieldChunkCap: "search.field_chunk_cap",
  /** model/mode/fieldChunkCap 变更后标记需要显式 reindex（两步纪律，§5.4）。 */
  reindexRequired: "search.reindex_required",
  /** 检索总门 db 覆盖：on/off/inherit（inherit=跟随 GX_M5_SEARCH，缺省即 inherit）。 */
  searchEnabled: "search.enabled",
} as const;


/**
 * Prisma AppSetting 访问面（最小结构；只声明本片实际用到的三个方法）。
 * 真实 Prisma 客户端可结构化赋值（harness 直接传 h.prisma），不静态绑 db 单例。
 */
interface AppSettingClient {
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

interface EnvEmbeddingSeed {
  mode: EmbeddingMode;
  provider: EmbeddingProviderKind;
  baseURL: string;
  apiKey: string;
  model: string;
  batchSize: number;
  timeoutMs: number;
  dim: number;
  concurrency: number;
  retryMaxAttempts: number;
  retryBaseMs: number;
  fieldChunkCap: number;
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) return fallback;
  return n;
}

/** 读 env 种子（只读、不写库）。未知 mode 回 off、未知 provider 回 cloud（向后兼容同款保守口径）。 */
export function readEnvEmbeddingSeed(env: NodeJS.ProcessEnv): EnvEmbeddingSeed {
  return {
    mode: parseEmbeddingMode(env.GX_EMBEDDING_MODE),
    provider: parseEmbeddingProvider(env.GX_EMBEDDING_PROVIDER),
    baseURL: env.GX_EMBEDDING_BASE_URL?.trim() ?? "",
    apiKey: env.GX_EMBEDDING_API_KEY?.trim() ?? "",
    model: env.GX_EMBEDDING_MODEL?.trim() ?? "",
    batchSize: positiveInt(env.GX_EMBEDDING_BATCH_SIZE, DEFAULT_BATCH_SIZE, 10000),
    timeoutMs: positiveInt(env.GX_EMBEDDING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 600000),
    dim: positiveInt(env.GX_EMBEDDING_DIM, 0, DIM_MAX),
    concurrency: positiveInt(env.GX_EMBEDDING_CONCURRENCY, DEFAULT_CONCURRENCY, CONCURRENCY_MAX),
    retryMaxAttempts: positiveInt(env.GX_EMBEDDING_RETRY_MAX, MAX_ATTEMPTS, RETRY_MAX_ATTEMPTS),
    retryBaseMs: positiveInt(env.GX_EMBEDDING_RETRY_BASE_MS, DEFAULT_RETRY_BASE_MS, 600000),
    fieldChunkCap: positiveInt(env.GX_SEARCH_FIELD_CHUNK_CAP, DEFAULT_FIELD_CHUNK_CAP, FIELD_CAP_MAX),
  };
}

// 加解密与字段校验见 ./embeddingSecret.js（按子功能拆文件）；此处原样再导出，
// 既有调用方/测试的导入路径不变。
import {
  encryptSecret,
  decryptSecret,
  maskApiKey,
  validateFieldChunkCap,
  validateDimOverride,
  validatePositiveInt,
  DEFAULT_FIELD_CHUNK_CAP,
  FIELD_CAP_MAX,
} from "./embeddingSecret.js";
export {
  deriveDataKey,
  encryptSecret,
  decryptSecret,
  maskApiKey,
  validateFieldChunkCap,
  validateDimOverride,
  validatePositiveInt,
  validateHttpUrl,
  DEFAULT_FIELD_CHUNK_CAP,
} from "./embeddingSecret.js";

// ===================== app_settings 持久化（主库 Prisma） =======================

export interface EmbeddingConfigView {
  mode: EmbeddingMode;
  provider: EmbeddingProviderKind;
  baseURL: string;
  model: string;
  batchSize: number;
  timeoutMs: number;
  /** 手填维度（0=未指定）。 */
  dim: number;
  concurrency: number;
  retryMaxAttempts: number;
  retryBaseMs: number;
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
  async setProvider(v: EmbeddingProviderKind): Promise<void> {
    await this.setRaw(SETTING_KEYS.provider, v.trim());
  }
  async setBaseUrl(v: string): Promise<void> { await this.setRaw(SETTING_KEYS.baseUrl, v.trim()); }
  async setModel(v: string): Promise<void> { await this.setRaw(SETTING_KEYS.model, v.trim()); }
  async setBatchSize(n: number): Promise<void> { await this.setRaw(SETTING_KEYS.batchSize, String(n)); }
  async setTimeoutMs(n: number): Promise<void> { await this.setRaw(SETTING_KEYS.timeoutMs, String(n)); }
  /** 手填维度；0 表示清除（沿用 model 元数据）。 */
  async setDim(n: number): Promise<void> {
    await this.setRaw(SETTING_KEYS.dim, String(validateDimOverride(n)));
  }
  async setConcurrency(n: number): Promise<void> {
    await this.setRaw(SETTING_KEYS.concurrency, String(validatePositiveInt(n, CONCURRENCY_MAX, "concurrency")));
  }
  async setRetryMaxAttempts(n: number): Promise<void> {
    await this.setRaw(
      SETTING_KEYS.retryMaxAttempts,
      String(validatePositiveInt(n, RETRY_MAX_ATTEMPTS, "retryMaxAttempts")),
    );
  }
  async setRetryBaseMs(n: number): Promise<void> {
    await this.setRaw(SETTING_KEYS.retryBaseMs, String(validatePositiveInt(n, 600000, "retryBaseMs")));
  }
  async setFieldChunkCap(n: number): Promise<void> {
    await this.setRaw(SETTING_KEYS.fieldChunkCap, String(validateFieldChunkCap(n)));
  }

  /** 检索总门 db 覆盖；写 "inherit" 等价于删除该键（跟随环境变量）。 */
  async setSearchEnabled(v: SearchEnabledOverride): Promise<void> {
    if (v === "inherit") {
      await this.client.appSetting.delete({ where: { k: SETTING_KEYS.searchEnabled } }).catch(() => undefined);
      return;
    }
    await this.setRaw(SETTING_KEYS.searchEnabled, v);
  }

  /** 读总门覆盖；键不存在/未知值一律 inherit（老库升级首态，绝不因此报错）。 */
  async getSearchEnabledOverride(): Promise<SearchEnabledOverride> {
    const raw = await this.getRaw(SETTING_KEYS.searchEnabled);
    const v = raw?.trim().toLowerCase();
    return v === "on" || v === "off" ? v : "inherit";
  }

  /** 标记/清除"配置已变、需显式重建"（§5.4 两步：PATCH 只标记，不自动重建）。 */
  async setReindexRequired(required: boolean): Promise<void> {
    await this.setRaw(SETTING_KEYS.reindexRequired, required ? "1" : "0");
  }

  /** 读重建标记；键不存在视为不需要（旧库升级首态）。 */
  async isReindexRequired(): Promise<boolean> {
    return (await this.getRaw(SETTING_KEYS.reindexRequired)) === "1";
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
    // provider 向后兼容：老库无 embedding.provider 键 -> 回 env 种子（未设则 "cloud"），
    // 与既有 cloud 行为完全一致，绝不因字段缺失读不出配置。
    const dbProvider = await this.getRaw(SETTING_KEYS.provider);
    const provider = dbProvider === undefined ? seed.provider : parseEmbeddingProvider(dbProvider);
    const baseURL = (await this.getRaw(SETTING_KEYS.baseUrl)) ?? seed.baseURL;
    const model = (await this.getRaw(SETTING_KEYS.model)) ?? seed.model;
    const batchSize = positiveInt(await this.getRaw(SETTING_KEYS.batchSize), seed.batchSize, 10000);
    const timeoutMs = positiveInt(await this.getRaw(SETTING_KEYS.timeoutMs), seed.timeoutMs, 600000);
    const dim = positiveInt(await this.getRaw(SETTING_KEYS.dim), seed.dim, DIM_MAX);
    const concurrency = positiveInt(await this.getRaw(SETTING_KEYS.concurrency), seed.concurrency, CONCURRENCY_MAX);
    const retryMaxAttempts = positiveInt(
      await this.getRaw(SETTING_KEYS.retryMaxAttempts), seed.retryMaxAttempts, RETRY_MAX_ATTEMPTS,
    );
    const retryBaseMs = positiveInt(await this.getRaw(SETTING_KEYS.retryBaseMs), seed.retryBaseMs, 600000);
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
    return {
      mode, provider, baseURL, model, batchSize, timeoutMs, dim,
      concurrency, retryMaxAttempts, retryBaseMs, fieldChunkCap,
      hasKey, keySource, maskedKey, dbKeyUndecryptable,
    };
  }
}
