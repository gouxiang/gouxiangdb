// M5/S9 embedding 配置管理 service（M5-implementation-plan §9、§5.4 两步纪律）。
//
// 纯 service：不 import Hono/req/res（分层纪律），由 adminSearch 路由做 owner 校验/审计/信封。
// 所有持久化经 EmbeddingConfigStore（AES-256-GCM），本文件绝不回明文 key（只回存在性/末4）。
// 维度不接受入参（dim 由 model 元数据决定）；mode/model/fieldChunkCap 变更只置 reindexRequired，
// 不自动重建、不接受 reindex:true（管理员须随后显式 POST /admin/reindex）。

import fs from "node:fs";
import Database from "better-sqlite3";
import type { PrismaClient } from "@prisma/client";
import {
  EmbeddingConfigStore,
  validateFieldChunkCap,
  validatePositiveInt,
  validateHttpUrl,
} from "./embeddingConfig.js";
import { META_KEYS } from "./schema.js";
import { parseEmbeddingMode, type EmbeddingMode } from "./embedding/types.js";

/** GET /admin/embedding/config 与 rotate 的 apiKey 存在性形状（§9）。 */
export interface ApiKeyStatus {
  configured: boolean;
  source: "env" | "db" | "none";
  maskedLast4: string | null;
}

export interface EmbeddingConfigResponse {
  mode: EmbeddingMode;
  baseURL: string;
  model: string;
  dim: number;
  batchSize: number;
  timeoutMs: number;
  fieldChunkCap: number;
  apiKey: ApiKeyStatus;
}

export interface PatchConfigResult {
  config: EmbeddingConfigResponse;
  /** mode/model/fieldChunkCap 变更后置 true（两步：不自动重建）。 */
  reindexRequired: boolean;
  /** 本次实际变更的字段名（审计用；绝不含 apiKey 值）。 */
  changed: string[];
  /** 本次是否在 PATCH 内轮换了 db key（路由据此记 embedding_api_key_rotated）。 */
  keyRotated: boolean;
}

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

const BATCH_MAX = 10000;
const TIMEOUT_MAX = 600000;

function readEmbeddingDim(searchPath: string | undefined): number {
  if (!searchPath || !fs.existsSync(searchPath)) return 0;
  const db = new Database(searchPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT v FROM index_meta WHERE k=?")
      .get(META_KEYS.embeddingDim) as { v: string } | undefined;
    return Number(row?.v ?? "0") || 0;
  } finally {
    db.close();
  }
}

function toApiKeyStatus(view: {
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

export interface ConfigDeps {
  prisma: PrismaClient;
  env: NodeJS.ProcessEnv;
  jwtSecret: string;
  /** search.db 路径（读 dim 用）；不给则不读维度。 */
  searchPath?: string;
}

async function resolveConfig(d: ConfigDeps): Promise<{
  store: EmbeddingConfigStore;
  view: Awaited<ReturnType<EmbeddingConfigStore["resolveView"]>>;
}> {
  const store = new EmbeddingConfigStore(d.prisma, d.jwtSecret);
  const view = await store.resolveView(d.env);
  return { store, view };
}

/** GET /admin/embedding/config。 */
export async function getEmbeddingConfig(d: ConfigDeps): Promise<EmbeddingConfigResponse> {
  const { view } = await resolveConfig(d);
  return {
    mode: view.mode,
    baseURL: view.baseURL,
    model: view.model,
    dim: readEmbeddingDim(d.searchPath),
    batchSize: view.batchSize,
    timeoutMs: view.timeoutMs,
    fieldChunkCap: view.fieldChunkCap,
    apiKey: toApiKeyStatus(view),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * PATCH /admin/embedding/config。白名单字段 + 全套校验；返回新配置 + reindexRequired。
 */
export async function patchEmbeddingConfig(
  d: ConfigDeps,
  rawBody: unknown,
): Promise<PatchConfigResult> {
  if (!isPlainObject(rawBody)) throw new EmbeddingConfigInvalid("请求体必须是 JSON 对象");
  const body = rawBody as Record<string, unknown>;

  // 硬禁键：维度不接受入参；reindex 不接受请求体（两步纪律）。
  if ("dim" in body || "dimensions" in body) {
    throw new EmbeddingConfigInvalid("维度由 model 元数据决定，不接受 dim/dimensions 入参");
  }
  if ("reindex" in body) {
    throw new EmbeddingConfigInvalid("不接受请求体 reindex 标记；请随后显式调用 reindex 端点");
  }

  const { store, view: before } = await resolveConfig(d);
  const changed: string[] = [];

  // ---- mode（off->cloud 需二次确认）----
  let nextMode: EmbeddingMode = before.mode;
  if (body.mode !== undefined) {
    if (typeof body.mode !== "string") throw new EmbeddingConfigInvalid("mode 必须是 off|cloud 字符串");
    const parsed = parseEmbeddingMode(body.mode);
    if (body.mode.trim().toLowerCase() !== "off" && body.mode.trim().toLowerCase() !== "cloud") {
      throw new EmbeddingConfigInvalid("mode 仅支持 off|cloud");
    }
    if (parsed === "cloud" && before.mode === "off" && body.confirmCloud !== true) {
      throw new NeedCloudConfirm();
    }
    nextMode = parsed;
    if (parsed !== before.mode) changed.push("mode");
  } else if (nextMode === "off") {
    // 未带 mode 但显式 confirmCloud 无意义；不处理。
  }

  // ---- baseURL ----
  if (body.baseURL !== undefined) {
    if (typeof body.baseURL !== "string") throw new EmbeddingConfigInvalid("baseURL 必须是字符串");
    let url: string;
    try {
      url = validateHttpUrl(body.baseURL);
    } catch (e) {
      throw new EmbeddingConfigInvalid(e instanceof Error ? e.message : "baseURL 非法");
    }
    if (url !== before.baseURL) {
      await store.setBaseUrl(url);
      changed.push("baseURL");
    }
  }

  // ---- model ----
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || body.model.trim() === "") {
      throw new EmbeddingConfigInvalid("model 必须是非空字符串");
    }
    const m = body.model.trim();
    if (m !== before.model) {
      await store.setModel(m);
      changed.push("model");
    }
  }

  // ---- batchSize / timeoutMs（正整数）----
  if (body.batchSize !== undefined) {
    if (typeof body.batchSize !== "number" || !Number.isInteger(body.batchSize)) {
      throw new EmbeddingConfigInvalid("batchSize 必须是正整数");
    }
    let n: number;
    try {
      n = validatePositiveInt(body.batchSize, BATCH_MAX, "batchSize");
    } catch (e) {
      throw new EmbeddingConfigInvalid(e instanceof Error ? e.message : "batchSize 非法");
    }
    if (n !== before.batchSize) {
      await store.setBatchSize(n);
      changed.push("batchSize");
    }
  }
  if (body.timeoutMs !== undefined) {
    if (typeof body.timeoutMs !== "number" || !Number.isInteger(body.timeoutMs)) {
      throw new EmbeddingConfigInvalid("timeoutMs 必须是正整数");
    }
    let n: number;
    try {
      n = validatePositiveInt(body.timeoutMs, TIMEOUT_MAX, "timeoutMs");
    } catch (e) {
      throw new EmbeddingConfigInvalid(e instanceof Error ? e.message : "timeoutMs 非法");
    }
    if (n !== before.timeoutMs) {
      await store.setTimeoutMs(n);
      changed.push("timeoutMs");
    }
  }

  // ---- fieldChunkCap（1..1000）----
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

  // mode 在最后落库（confirmCloud 已过）。
  if (changed.includes("mode")) await store.setMode(nextMode);

  // ---- apiKey：字符串=加密覆盖；缺省=保持；显式 null=清库存 ----
  let keyRotated = false;
  if ("apiKey" in body) {
    if (body.apiKey === null) {
      await store.deleteApiKey();
      changed.push("apiKey:cleared");
    } else if (typeof body.apiKey === "string") {
      if (body.apiKey.trim() === "") throw new EmbeddingConfigInvalid("apiKey 不接受空字符串；清除请传 null");
      await store.setApiKey(body.apiKey);
      keyRotated = true;
      changed.push("apiKey");
    } else {
      throw new EmbeddingConfigInvalid("apiKey 必须是字符串（覆盖）或 null（清除）");
    }
  }

  // mode/model/fieldChunkCap 变更 -> 置重建标记（baseURL/key/batch/timeout 不影响派生内容）。
  const affectsIndex = changed.some((k) => k === "mode" || k === "model" || k === "fieldChunkCap");
  let reindexRequired = await store.isReindexRequired();
  if (affectsIndex) {
    reindexRequired = true;
    await store.setReindexRequired(true);
  }

  const after = await getEmbeddingConfig(d);
  return { config: after, reindexRequired, changed, keyRotated };
}

/** POST /admin/embedding/api-key/rotate：加密落库，回存在性形状。 */
export async function rotateApiKey(
  d: ConfigDeps,
  rawBody: unknown,
): Promise<ApiKeyStatus> {
  if (!isPlainObject(rawBody) || typeof rawBody.apiKey !== "string" || rawBody.apiKey.trim() === "") {
    throw new EmbeddingConfigInvalid("请求体必须包含非空字符串 apiKey");
  }
  const { store } = await resolveConfig(d);
  await store.setApiKey(rawBody.apiKey);
  const view = await store.resolveView(d.env);
  return toApiKeyStatus(view);
}

/** DELETE /admin/embedding/api-key：清 db key，回落 env 种子或 none。 */
export async function clearApiKey(d: ConfigDeps): Promise<ApiKeyStatus> {
  const { store } = await resolveConfig(d);
  await store.deleteApiKey();
  const view = await store.resolveView(d.env);
  return toApiKeyStatus(view);
}
