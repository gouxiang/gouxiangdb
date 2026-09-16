// M5/S6-S7 /api/v1/search：GX_M5_SEARCH 门 + M5/S7 真实统一检索与 shadow 对拍。
//
// 挂载纪律（M5 计划 §6/§17-S6）：本子路由【仅在 config.m5Search !== "off"】时由
// routes/v1/index.ts 条件挂载；off 时 /api/v1/search 落 v1 自身 404。默认 off -> 本文件
// 不被 import 链上的 store/provider 触达，旧 /api/search 字节不变。
//
//   on     = 正常返回新统一检索链路（query.ts 先收敛后召回）结果；
//   shadow = 新链路照跑，但响应仍走旧 /api/search 结果（runLegacyGlobalSearch），二者在
//            可比集（都 FTS/LIKE）对拍，只记脱敏日志/metric，不改变/不污染响应；
//            GX_M5_SHADOW_STRICT=on 时 drift 非 0 才让该请求失败（§6 对拍闸门）。
// 向量召回是新增能力，不与旧 includes 对拍（hybrid/vector 跳过对拍）。

import { Hono } from "hono";
import { config } from "../../config.js";
import { prisma } from "../../db.js";
import { HttpError } from "../../guards.js";
import { executeUnifiedSearch } from "../../domain/search/query.js";
import { buildQueryRuntime } from "../../domain/search/queryRuntime.js";
import { runLegacyGlobalSearch } from "../../domain/search/legacySearch.js";
import {
  compareSearchShadow,
  searchShadowRegistry,
} from "../../domain/search/queryShadow.js";
import { emptySearchResponse } from "../../domain/search/queryTypes.js";
import type { EntityTypeFilter, RequestedMode } from "../../domain/search/queryPlan.js";

export const searchRoutes = new Hono();

const TYPES: ReadonlySet<EntityTypeFilter> = new Set(["all", "record", "doc", "canvas"]);
const MODES: ReadonlySet<RequestedMode> = new Set(["auto", "fts", "vector"]);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parseParams(q: string | undefined, typeRaw: string, modeRaw: string, limitRaw: string) {
  const rawQ = q ?? "";
  // 未知 type/mode 保守回默认（不 400：与旧搜索宽容口径一致，计划只对 limit 设硬门）。
  const type = (TYPES.has(typeRaw as EntityTypeFilter) ? typeRaw : "all") as EntityTypeFilter;
  const mode = (MODES.has(modeRaw as RequestedMode) ? modeRaw : "auto") as RequestedMode;
  let limit = DEFAULT_LIMIT;
  if (limitRaw) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      throw new HttpError(400, "limit 必须是 1..50 的整数", "SEARCH_BAD_LIMIT");
    }
    limit = n;
  }
  return { rawQ, type, mode, limit };
}

searchRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  const { rawQ, type, mode, limit } = parseParams(
    c.req.query("q"),
    c.req.query("type") ?? "all",
    c.req.query("mode") ?? "auto",
    c.req.query("limit") ?? "",
  );
  const hadQuery = rawQ.trim().length > 0;

  // 空 q：两态都回空结果（on 回 §9 空壳；shadow 旧链本来也是 {records:[],docs:[]}），
  // 且在打开 search.db 之前短路（默认形态零建库）。
  if (!hadQuery) {
    if (config.m5Search === "shadow") return c.json({ records: [], docs: [] });
    return c.json(emptySearchResponse(limit));
  }

  // shadow 态：旧链结果始终是响应真源（先算，保证新链任何异常都不污染响应）。
  const legacy = config.m5Search === "shadow"
    ? await runLegacyGlobalSearch(prisma, userId, rawQ)
    : null;

  // 新链路（on=返回它；shadow=只跑用于对拍）。shadow 下其异常默认吞掉只记日志，STRICT 才失败。
  const { deps } = await buildQueryRuntime(userId, type, {
    prisma, env: process.env, dataDir: config.dataDir, appDir: config.appDir,
    jwtSecret: config.jwtSecret,
  });
  let unified: Awaited<ReturnType<typeof executeUnifiedSearch>> | null = null;
  let newChainError: unknown = null;
  try {
    unified = await executeUnifiedSearch(deps, { q: rawQ, type, mode, limit }, false);
  } catch (err) {
    newChainError = err;
  }

  if (config.m5Search === "shadow") {
    if (newChainError) {
      // 新链自身故障：非 STRICT 不影响旧响应，仅记脱敏日志。
      console.warn("[m5-search-shadow] new chain error:",
        newChainError instanceof Error ? newChainError.message : String(newChainError));
      if (config.m5ShadowStrict) {
        throw new HttpError(500, "统一检索新链路异常（shadow strict）", "M5_SHADOW_NEW_CHAIN_ERROR");
      }
      return c.json(legacy);
    }
    const report = compareSearchShadow(unified!.mode, unified!.items, legacy!, hadQuery);
    searchShadowRegistry.record(report, userId);
    if (config.m5ShadowStrict && report.comparable && report.driftCount > 0) {
      // §6 对拍闸门：strict 下 drift 非 0 让请求失败（不含实体业务值）。
      throw new HttpError(500, "统一检索 shadow 对拍漂移（strict 闸门）", "M5_SHADOW_DRIFT");
    }
    return c.json(legacy); // 响应永远是旧结果
  }

  // on：新链异常直接走错误信封（不回退旧链，避免 on 态偷偷改变契约；search.db 损坏的应急在 S12）。
  if (newChainError) throw newChainError;
  return c.json(unified);
});
