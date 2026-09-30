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
import { writeAudit } from "../../audit/audit.js";
import { sourceIp } from "../../utils/client-ip.js";
import { executeUnifiedSearch } from "../../domain/search/query.js";
import { buildQueryRuntime } from "../../domain/search/queryRuntime.js";
import { loadSearchGateFlag } from "../../domain/search/searchGate.js";
import { runOnSearch } from "../../domain/search/searchRun.js";
import { observeDegrade } from "../../domain/search/degradeAudit.js";
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

  // 总门 db 覆盖（app_settings 的 search.enabled）：请求期解析，改了立即生效。
  // 权威顺序：覆盖值显式 on/off > 环境变量 > 默认 off——故 env=off 时后台置 on 也能在这里打开检索
  // （路由恒挂载，见 routes/v1/index.ts）。判定为 off 一律 404，且在任何 search.db 访问前短路。
  const gateFlag = await loadSearchGateFlag(prisma, config.jwtSecret, process.env, config.m5Search);
  if (gateFlag === "off") {
    throw new HttpError(404, "统一检索未启用", "NOT_FOUND");
  }

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
    if (gateFlag === "shadow") return c.json({ records: [], docs: [] });
    return c.json(emptySearchResponse(limit));
  }

  // 降级跳变采样（on/shadow 共用同一份纯状态机）；仅在状态变化时落一条脱敏 search_degraded。
  const sampleDegrade = (res: { mode: string; degraded: readonly string[] }): void => {
    const hit = observeDegrade({
      mode: res.mode,
      reasons: res.degraded,
      recovering: res.degraded.includes("search_store_recovering"),
    });
    if (hit) {
      writeAudit(config.auditDir, {
        event: "search_degraded",
        actorId: null, // 系统事件：不挂检索主体，detail 只含技术态（无 q/标题/字段/key/向量）
        ip: sourceIp(c),
        method: "GET",
        path: c.req.path,
        status: 200,
        detail: hit.detail,
      });
    }
  };

  let unified: Awaited<ReturnType<typeof executeUnifiedSearch>>;

  if (gateFlag === "shadow") {
    // shadow 态：旧链结果始终是响应真源（先算，保证新链任何异常都不污染响应）。
    const legacy = await runLegacyGlobalSearch(prisma, userId, rawQ);
    let newChainError: unknown = null;
    try {
      const { deps } = await buildQueryRuntime(userId, type, {
        prisma, env: process.env, dataDir: config.dataDir, appDir: config.appDir,
        jwtSecret: config.jwtSecret,
      });
      unified = await executeUnifiedSearch(deps, { q: rawQ, type, mode, limit }, false);
    } catch (err) {
      newChainError = err;
    }
    if (newChainError) {
      // 新链自身故障（含 search.db 损坏）：shadow 不自愈、不污染旧响应，仅记脱敏日志。
      console.warn("[m5-search-shadow] new chain error:",
        newChainError instanceof Error ? newChainError.message : String(newChainError));
      if (config.m5ShadowStrict) {
        throw new HttpError(500, "统一检索新链路异常（shadow strict）", "M5_SHADOW_NEW_CHAIN_ERROR");
      }
      return c.json(legacy);
    }
    const report = compareSearchShadow(unified!.mode, unified!.items, legacy, hadQuery);
    searchShadowRegistry.record(report, userId);
    if (config.m5ShadowStrict && report.comparable && report.setDriftCount > 0) {
      // §6 对拍闸门（2026-09-17 总监裁决）：strict 只对【集合漂移】（漏召回/多召回）失败；
      // ORDER 是 RRF/boost 的设计内排序改进，降为观测（registry 计数 + warn），不再让请求失败。
      throw new HttpError(500, "统一检索 shadow 集合漂移（strict 闸门）", "M5_SHADOW_DRIFT");
    }
    return c.json(legacy); // 响应永远是旧结果
  }

  // on 态：复用共享执行段（GET 纯文本；images 缺省）。损坏自愈/repopulating 应急都在其中。
  unified = await runOnSearch({
    userId, prisma, rawQ, type, mode, limit,
    requestPath: c.req.path, sourceIp: sourceIp(c),
  });

  sampleDegrade(unified);
  return c.json(unified);
});

// ---- POST /api/v1/search：以图搜图（GET 装不下 dataURL，故同路径提供 POST）----
// 仅比 GET 多一个 images（data:image/...）。响应契约与 GET 逐字段一致；GET 行为零变化。

const MAX_IMAGES = 4;

searchRoutes.post("/", async (c) => {
  const userId = c.get("auth").userId;

  // 总门与 GET 同一真源；off 同样 404。
  const gateFlag = await loadSearchGateFlag(prisma, config.jwtSecret, process.env, config.m5Search);
  if (gateFlag === "off") {
    throw new HttpError(404, "统一检索未启用", "NOT_FOUND");
  }

  const body = await c.req.json().catch(() => null) as {
    q?: unknown; type?: unknown; mode?: unknown; limit?: unknown; images?: unknown;
  } | null;
  if (!body || typeof body !== "object") {
    throw new HttpError(400, "请求体必须是 JSON 对象", "SEARCH_BAD_BODY");
  }

  const rawQ = typeof body.q === "string" ? body.q : "";
  const type = (TYPES.has(body.type as EntityTypeFilter) ? body.type : "all") as EntityTypeFilter;
  const mode = (MODES.has(body.mode as RequestedMode) ? body.mode : "auto") as RequestedMode;
  let limit = DEFAULT_LIMIT;
  if (body.limit !== undefined && body.limit !== null) {
    const n = Number(body.limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      throw new HttpError(400, "limit 必须是 1..50 的整数", "SEARCH_BAD_LIMIT");
    }
    limit = n;
  }

  // 图片：仅接受 data:image/* 内联数据（用户本地上传）；过滤非法项，限 4 张。
  let images: string[] = [];
  if (body.images !== undefined) {
    if (!Array.isArray(body.images)) {
      throw new HttpError(400, "images 必须是数组", "SEARCH_BAD_IMAGES");
    }
    images = body.images.filter(
      (u): u is string => typeof u === "string" && u.startsWith("data:image/"),
    );
    if (images.length > MAX_IMAGES) images = images.slice(0, MAX_IMAGES);
  }

  const hasText = rawQ.trim().length > 0;
  if (!hasText && images.length === 0) {
    // 无文本也无图：与 GET 空 q 一致回空壳。
    return c.json(emptySearchResponse(limit));
  }

  // shadow 态 POST 不做对拍（多模态为新增能力，GET shadow 对拍仅限可比纯文本集），
  // 直接走 on 执行链；响应以新链路为准。
  const unified = await runOnSearch({
    userId, prisma, rawQ, type, mode, limit, images,
    requestPath: c.req.path, sourceIp: sourceIp(c),
  });
  return c.json(unified);
});
