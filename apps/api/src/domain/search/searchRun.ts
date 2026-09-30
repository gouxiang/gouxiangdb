// on 态统一检索执行段（GET /api/v1/search 与 POST /api/v1/search 共用）。
//
// 从 routes/v1/search.ts 抽出，纯粹为让"纯文本 GET"与"以图搜图 POST"复用同一条
// 先收敛后召回链路（含 search.db 物理损坏自愈、repopulating 应急 LIKE），杜绝两份逻辑漂移。
// 本文件只做编排装配；降级采样所需的 audit 写入路径/IP 由调用方传入。

import type { PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { writeAudit } from "../../audit/audit.js";
import { executeUnifiedSearch } from "./query.js";
import { buildQueryRuntime } from "./queryRuntime.js";
import { resolveSearchDbPath } from "./searchStore.js";
import { isCorruptionError } from "./searchCorruption.js";
import {
  recoverCorruptSearchStore,
  repopulateRecoveredStore,
  isRepopulating,
} from "./searchRecovery.js";
import { executeEmergencyLike } from "./emergencyLike.js";
import { observeDegrade } from "./degradeAudit.js";
import type { UnifiedSearchResponse } from "./queryTypes.js";
import type { EntityTypeFilter, RequestedMode } from "./queryPlan.js";

export interface RunSearchInput {
  userId: string;
  prisma: PrismaClient;
  /** 原始（未 trim）查询词；纯以图搜图可为空串。 */
  rawQ: string;
  type: EntityTypeFilter;
  mode: RequestedMode;
  limit: number;
  /** 以图搜图图片（data:image/...）；缺省=纯文本。 */
  images?: readonly string[];
  /** audit 写入定位（降级事件）。 */
  requestPath: string;
  sourceIp: string;
}

/** 降级跳变采样：仅在状态变化时落一条脱敏 search_degraded（无 q/标题/字段/key/向量）。 */
function sampleDegrade(res: { mode: string; degraded: readonly string[] }, inp: RunSearchInput): void {
  const hit = observeDegrade({
    mode: res.mode,
    reasons: res.degraded,
    recovering: res.degraded.includes("search_store_recovering"),
  });
  if (!hit) return;
  writeAudit(config.auditDir, {
    event: "search_degraded",
    actorId: null, // 系统事件：不挂检索主体，detail 只含技术态
    ip: inp.sourceIp,
    method: "POST",
    path: inp.requestPath,
    status: 200,
    detail: hit.detail,
  });
}

/**
 * 执行 on 态统一检索。
 * - repopulating 窗口：走主库应急 LIKE（scope 实时收敛，绝不放宽授权）；
 * - search.db 物理损坏：隔离坏库、当次应急 LIKE、后台重播；
 * - 正常：buildQueryRuntime + executeUnifiedSearch。
 */
export async function runOnSearch(inp: RunSearchInput): Promise<UnifiedSearchResponse> {
  const { prisma, userId, rawQ, type, mode, limit, images } = inp;
  const runtimeOpts = {
    prisma, env: process.env, dataDir: config.dataDir, appDir: config.appDir,
    jwtSecret: config.jwtSecret,
  };

  if (isRepopulating()) {
    const { deps } = await buildQueryRuntime(userId, type, runtimeOpts);
    const unified = await executeEmergencyLike(prisma, await deps.resolveScope(), rawQ.trim(), limit);
    sampleDegrade(unified, inp);
    return unified;
  }

  try {
    const { deps } = await buildQueryRuntime(userId, type, runtimeOpts);
    return await executeUnifiedSearch(deps, { q: rawQ, type, mode, limit, images }, false);
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    const searchPath = resolveSearchDbPath(process.env, config.dataDir);
    const recovered = await recoverCorruptSearchStore(searchPath, {
      appDir: config.appDir,
      ...(process.env.GX_VEC_EXT_PATH?.trim() ? { vecExtPath: process.env.GX_VEC_EXT_PATH.trim() } : {}),
    });
    const { deps: freshDeps } = await buildQueryRuntime(userId, type, {
      ...runtimeOpts, store: recovered.store,
    });
    const scope = await freshDeps.resolveScope();
    const unified = await executeEmergencyLike(prisma, scope, rawQ.trim(), limit);
    // 后台重播（fire-and-forget）：cloud embed 失败按欠账后补。
    void repopulateRecoveredStore({
      prisma, env: process.env, dataDir: config.dataDir, appDir: config.appDir,
      jwtSecret: config.jwtSecret, searchPath,
      ...(process.env.GX_VEC_EXT_PATH?.trim() ? { vecExtPath: process.env.GX_VEC_EXT_PATH.trim() } : {}),
    });
    return unified;
  }
}
