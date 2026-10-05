// M5/S9 embedding 配置管理 service（M5-implementation-plan §9、§5.4 两步纪律）。
//
// 纯 service：不 import Hono/req/res（分层纪律），由 adminSearch 路由做 owner 校验/审计/信封。
// 所有持久化经 EmbeddingConfigStore（AES-256-GCM），本文件绝不回明文 key（只回存在性/末4）。
// 字段级校验与落库在 adminEmbeddingFields.ts（按子功能拆文件，保单文件行数门禁）；
// 本文件只做编排：顺序、二次确认、重建标记、返回值装配。
//
// 纪律：mode/provider/dim/model/fieldChunkCap 变更只置 reindexRequired，不自动重建、
// 不接受 reindex:true（管理员须随后显式 POST /admin/reindex）。

import fs from "node:fs";
import Database from "better-sqlite3";
import type { PrismaClient } from "@prisma/client";
import { providerAllowsManualDim, type EmbeddingProviderKind, type SearchGateDTO } from "@gx/shared-types";
import { EmbeddingConfigStore } from "./embeddingConfig.js";
import { META_KEYS } from "./schema.js";
import { parseEmbeddingMode, type EmbeddingMode } from "./embedding/types.js";
import { buildSearchGate } from "./searchGate.js";
import {
  EmbeddingConfigInvalid,
  NeedCloudConfirm,
  applyApiKey,
  applyProviderAndDim,
  applySearchGate,
  applyTextAndNumericFields,
  toApiKeyStatus,
  type ApiKeyStatus,
  type ApplyCtx,
} from "./adminEmbeddingFields.js";

// 路由与其它模块从本文件取错误类型（真源在 adminEmbeddingFields.js）。
export { EmbeddingConfigInvalid, NeedCloudConfirm } from "./adminEmbeddingFields.js";
export type { ApiKeyStatus } from "./adminEmbeddingFields.js";

interface EmbeddingConfigResponse {
  mode: EmbeddingMode;
  provider: EmbeddingProviderKind;
  baseURL: string;
  model: string;
  /** 现役索引维度（只读，来自 search.db）。 */
  dim: number;
  /** 手填维度（0=未指定，沿用 model 元数据）。 */
  dimOverride: number;
  /** 当前服务形态是否允许手填维度。 */
  dimEditable: boolean;
  batchSize: number;
  timeoutMs: number;
  fieldChunkCap: number;
  concurrency: number;
  retryMaxAttempts: number;
  retryBaseMs: number;
  apiKey: ApiKeyStatus;
  /** 检索总门：env 基础态 + db 覆盖 + 各生效面是否需重启。 */
  searchGate: SearchGateDTO;
}

interface PatchConfigResult {
  config: EmbeddingConfigResponse;
  /** mode/model/provider/dim/fieldChunkCap 变更后置 true（两步：不自动重建）。 */
  reindexRequired: boolean;
  /** 本次实际变更的字段名（审计用；绝不含 apiKey 值）。 */
  changed: string[];
  /** 本次是否在 PATCH 内轮换了 db key（路由据此记 embedding_api_key_rotated）。 */
  keyRotated: boolean;
}

/** 读 search.db 的现役索引维度（只读直开，绝不建库）。 */
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

interface ConfigDeps {
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
    provider: view.provider,
    baseURL: view.baseURL,
    model: view.model,
    dim: readEmbeddingDim(d.searchPath),
    dimOverride: view.dim,
    dimEditable: providerAllowsManualDim(view.provider),
    batchSize: view.batchSize,
    timeoutMs: view.timeoutMs,
    fieldChunkCap: view.fieldChunkCap,
    concurrency: view.concurrency,
    retryMaxAttempts: view.retryMaxAttempts,
    retryBaseMs: view.retryBaseMs,
    apiKey: toApiKeyStatus(view),
    searchGate: await buildSearchGate(d.prisma, d.jwtSecret, d.env),
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

  if ("reindex" in body) {
    throw new EmbeddingConfigInvalid("不接受请求体 reindex 标记；请随后显式调用 reindex 端点");
  }

  const { store, view: before } = await resolveConfig(d);
  const changed: string[] = [];
  const ctx: ApplyCtx = { store, before, body, changed };

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
  }

  // ---- provider + dim（顺序不可换：维度能否手填由目标形态决定）----
  const nextProvider = await applyProviderAndDim(ctx);

  // ---- 文本/数值字段（含并发与重试）----
  await applyTextAndNumericFields(ctx);

  // ---- 检索总门 db 覆盖 ----
  await applySearchGate(ctx);

  // mode/provider 在最后落库（confirmCloud 已过）。
  if (changed.includes("mode")) await store.setMode(nextMode);
  if (changed.includes("provider")) await store.setProvider(nextProvider);

  // ---- apiKey ----
  const keyRotated = await applyApiKey(ctx);

  // mode/provider/dim/model/fieldChunkCap 变更 -> 置重建标记
  // （baseURL/key/batch/timeout/并发/重试只影响调用节奏，不改变派生内容）。
  const affectsIndex = changed.some(
    (k) => k === "mode" || k === "model" || k === "fieldChunkCap" || k === "provider" || k === "dim",
  );
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
