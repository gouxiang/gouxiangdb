// M5/S9 PATCH /admin/embedding/config 的字段级落库（从 adminEmbedding.ts 拆出，保单文件行数门禁）。
//
// 纯 service 片段：不 import Hono/req/res，只认 EmbeddingConfigStore 与请求体；
// 每个 apply* 负责"校验白名单字段 + 落库 + 记录 changed"，编排顺序在 adminEmbedding.ts。
// 全部非法入参抛 EmbeddingConfigInvalid（路由转 400），off->cloud 缺确认抛 NeedCloudConfirm（409）。

import type { EmbeddingConfigView, EmbeddingConfigStore } from "./embeddingConfig.js";
import {
  validateFieldChunkCap,
  validatePositiveInt,
  validateHttpUrl,
} from "./embeddingConfig.js";
import {
  providerAllowsManualDim,
  type EmbeddingProviderKind,
  type SearchEnabledOverride,
} from "@gx/shared-types";
import { parseEmbeddingProvider } from "./embedding/types.js";
import { parseSearchEnabledOverride } from "./searchGate.js";

const BATCH_MAX = 10000;
const TIMEOUT_MAX = 600000;
const CONCURRENCY_MAX = 64;
const RETRY_MAX = 10;
const RETRY_BASE_MAX = 600000;
const DIM_MAX = 4096;

/** PATCH 配置非法 -> 400 EMBEDDING_CONFIG_INVALID。 */
export class EmbeddingConfigInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingConfigInvalid";
  }
}
/** off->cloud 缺二次确认 -> 409 NEED_CLOUD_CONFIRM。 */
export class NeedCloudConfirm extends Error {
  constructor() {
    super("启用云端嵌入需要二次确认（confirmCloud:true）");
    this.name = "NeedCloudConfirm";
  }
}

/** GET /admin/embedding/config 与 rotate 的 apiKey 存在性形状（§9）。 */
export interface ApiKeyStatus {
  configured: boolean;
  source: "env" | "db" | "none";
  maskedLast4: string | null;
}

export function toApiKeyStatus(view: {
  hasKey: boolean;
  keySource: "db" | "env" | "none";
  maskedKey: string | null;
  dbKeyUndecryptable: boolean;
}): ApiKeyStatus {
  // JWT_SECRET 轮换致 db 密文不可解：resolveView 已回落 hasKey=false，source 按 env/none 判定，
  // 此处显式归一 source（契约：解密失败 configured:false/source:none，绝不 500）。
  if (view.dbKeyUndecryptable && view.keySource === "none") {
    return { configured: false, source: "none", maskedLast4: null };
  }
  const maskedLast4 = view.maskedKey ? view.maskedKey.replace(/^\*+/, "") : null;
  return {
    configured: view.hasKey,
    source: view.hasKey ? view.keySource : "none",
    maskedLast4: maskedLast4 && maskedLast4.length > 0 ? maskedLast4 : null,
  };
}

/** 校验正整数并落库（值未变则不写、不记 changed）。 */
async function writeInt(
  store: EmbeddingConfigStore,
  before: number,
  raw: unknown,
  field: string,
  max: number,
  write: (n: number) => Promise<void>,
  changed: string[],
  label: string,
): Promise<void> {
  // 字段缺省=保持原值（不是非法）：先短路，绝不能把 undefined 当 0/NaN 判非法。
  if (raw === undefined) return;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new EmbeddingConfigInvalid(`${label}必须是 1..${max} 的整数`);
  }
  let n: number;
  try {
    n = validatePositiveInt(raw, max, field);
  } catch (e) {
    throw new EmbeddingConfigInvalid(e instanceof Error ? e.message : `${field} 非法`);
  }
  if (n !== before) {
    await write(n);
    changed.push(field);
  }
}

/** 单个 apply* 的共用上下文。 */
export interface ApplyCtx {
  store: EmbeddingConfigStore;
  /** 变更前的配置视图（db 覆盖 env 后的口径）。 */
  before: EmbeddingConfigView;
  body: Record<string, unknown>;
  /** 本次实际变更的字段名（审计用；绝不含 apiKey 值）。 */
  changed: string[];
}

/**
 * provider + dim：必须先解析 provider，因为"维度能否手填"由【目标】形态决定。
 * 返回目标形态供后续落库使用。
 */
export async function applyProviderAndDim(ctx: ApplyCtx): Promise<EmbeddingProviderKind> {
  const { store, before, body, changed } = ctx;
  let nextProvider: EmbeddingProviderKind = before.provider;
  if (body.provider !== undefined) {
    if (typeof body.provider !== "string") {
      throw new EmbeddingConfigInvalid("provider 必须是 cloud|openai-compatible|self-hosted 字符串");
    }
    const v = body.provider.trim().toLowerCase();
    if (v !== "cloud" && v !== "openai-compatible" && v !== "self-hosted") {
      throw new EmbeddingConfigInvalid("provider 仅支持 cloud|openai-compatible|self-hosted");
    }
    nextProvider = parseEmbeddingProvider(v);
    if (nextProvider !== before.provider) changed.push("provider");
  }

  // dim：仅 openai-compatible / self-hosted 可手填 —— cloud 档填错维度会直接把 vec 索引写坏。
  if (body.dim !== undefined || body.dimensions !== undefined) {
    const rawDim = body.dim !== undefined ? body.dim : body.dimensions;
    if (!providerAllowsManualDim(nextProvider)) {
      throw new EmbeddingConfigInvalid(
        "当前服务形态的维度由 model 元数据决定；如需手动指定维度，请先把服务形态切换为 openai-compatible 或 self-hosted",
      );
    }
    if (typeof rawDim !== "number" || !Number.isInteger(rawDim) || rawDim < 1 || rawDim > DIM_MAX) {
      throw new EmbeddingConfigInvalid(`dim 必须是 1..${DIM_MAX} 的整数`);
    }
    if (rawDim !== before.dim) {
      await store.setDim(rawDim);
      changed.push("dim");
    }
  }
  // 切回 cloud 档：清掉手填维度，避免残留值与 model 元数据打架。
  if (changed.includes("provider") && !providerAllowsManualDim(nextProvider) && before.dim !== 0) {
    await store.setDim(0);
    changed.push("dim");
  }
  return nextProvider;
}

/** 文本与数值字段：baseURL / model / batchSize / timeoutMs / fieldChunkCap / 并发 / 重试。 */
export async function applyTextAndNumericFields(ctx: ApplyCtx): Promise<void> {
  const { store, before, body, changed } = ctx;

  // baseURL：空串按"还没填"跳过，不落库也不报 400。
  // 为什么：管理员点"启用云端语义检索"时服务地址/模型名必然还是空的，若把空串当非法 URL
  // 打回，人就被卡死在启用这一步（后续状态面板会如实显示配置不完整）。真正畸形的值仍 400。
  if (body.baseURL !== undefined && typeof body.baseURL === "string") {
    const trimmed = body.baseURL.trim();
    if (trimmed !== "") {
      let url: string;
      try {
        url = validateHttpUrl(trimmed);
      } catch (e) {
        throw new EmbeddingConfigInvalid(e instanceof Error ? e.message : "baseURL 非法");
      }
      if (url !== before.baseURL) {
        await store.setBaseUrl(url);
        changed.push("baseURL");
      }
    }
  } else if (body.baseURL !== undefined) {
    throw new EmbeddingConfigInvalid("baseURL 必须是字符串");
  }

  // model：同上，空串按"还没填"跳过；非空才校验落库。
  if (body.model !== undefined && typeof body.model === "string") {
    const m = body.model.trim();
    if (m !== "" && m !== before.model) {
      await store.setModel(m);
      changed.push("model");
    }
  } else if (body.model !== undefined) {
    throw new EmbeddingConfigInvalid("model 必须是非空字符串");
  }

  await writeInt(store, before.batchSize, body.batchSize, "batchSize", BATCH_MAX,
    (n) => store.setBatchSize(n), changed, "batchSize");
  await writeInt(store, before.timeoutMs, body.timeoutMs, "timeoutMs", TIMEOUT_MAX,
    (n) => store.setTimeoutMs(n), changed, "timeoutMs");

  if (body.fieldChunkCap !== undefined) {
    if (typeof body.fieldChunkCap !== "number" || !Number.isInteger(body.fieldChunkCap)) {
      throw new EmbeddingConfigInvalid("fieldChunkCap 必须是 1..1000 的整数");
    }
    let n: number;
    try {
      n = validateFieldChunkCap(body.fieldChunkCap);
    } catch (e) {
      throw new EmbeddingConfigInvalid(e instanceof Error ? e.message : "fieldChunkCap 非法");
    }
    if (n !== before.fieldChunkCap) {
      await store.setFieldChunkCap(n);
      changed.push("fieldChunkCap");
    }
  }

  // 并发与重试：真的会被 provider 消费（并发进信号量、重试进尝试次数与退避基数）。
  await writeInt(store, before.concurrency, body.concurrency, "concurrency", CONCURRENCY_MAX,
    (n) => store.setConcurrency(n), changed, "concurrency");
  await writeInt(store, before.retryMaxAttempts, body.retryMaxAttempts, "retryMaxAttempts", RETRY_MAX,
    (n) => store.setRetryMaxAttempts(n), changed, "retryMaxAttempts");
  await writeInt(store, before.retryBaseMs, body.retryBaseMs, "retryBaseMs", RETRY_BASE_MAX,
    (n) => store.setRetryBaseMs(n), changed, "retryBaseMs");
}

/** 检索总门 db 覆盖（search.enabled）：on/off/inherit，写 inherit 等价删键。 */
export async function applySearchGate(ctx: ApplyCtx): Promise<void> {
  const { store, body, changed } = ctx;
  if (body.searchEnabled === undefined) return;
  if (typeof body.searchEnabled !== "string") {
    throw new EmbeddingConfigInvalid("searchEnabled 必须是 on|off|inherit 字符串");
  }
  const v = body.searchEnabled.trim().toLowerCase();
  if (v !== "on" && v !== "off" && v !== "inherit") {
    throw new EmbeddingConfigInvalid("searchEnabled 仅支持 on|off|inherit");
  }
  const next = parseSearchEnabledOverride(v) as SearchEnabledOverride;
  if (next !== (await store.getSearchEnabledOverride())) {
    await store.setSearchEnabled(next);
    changed.push("searchEnabled");
  }
}

/**
 * apiKey：字符串=加密覆盖；缺省=保持；显式 null=清库存。
 * 返回本次是否轮换了 db key（路由据此记 embedding_api_key_rotated）。
 */
export async function applyApiKey(ctx: ApplyCtx): Promise<boolean> {
  const { store, body, changed } = ctx;
  if (!("apiKey" in body)) return false;
  if (body.apiKey === null) {
    await store.deleteApiKey();
    changed.push("apiKey:cleared");
    return false;
  }
  if (typeof body.apiKey === "string") {
    if (body.apiKey.trim() === "") throw new EmbeddingConfigInvalid("apiKey 不接受空字符串；清除请传 null");
    await store.setApiKey(body.apiKey);
    changed.push("apiKey");
    return true;
  }
  throw new EmbeddingConfigInvalid("apiKey 必须是字符串（覆盖）或 null（清除）");
}
