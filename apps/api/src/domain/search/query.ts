// M5/S7 先收敛后召回主编排（§4.5 九步）。本文件只做编排与降级决策；SQL 执行在 queryRecall，
// 装配在 queryHydrate，计划/融合/授权纯函数复用 S3 queryPlan/rrf/fieldGrant，不重写。
//
// 九步落点：
//   1 trim；空 q -> {items:[],mode:'like'}（emptySearchResponse），不跑 scope/召回。
//   1b mode=auto|fts|vector；强制档能力不可用自动回退并在 degraded 标注，绝不报错/绝不放宽权限。
//   2 resolveVisibleNodeIds(actions:['r'], kinds 映射) 收敛；nodeIds 空直接空结果（不跑召回）。
//   3+4 【先 await embed(q)】再进 runRecall 的纯同步无 await 会话：唯一后缀 temp_scope/
//        temp_field_grant 物化 -> FTS(>=3 码元)/LIKE(<3)/vec 三路白名单内召回（硬红线见 queryRecall）。
//   5 RRF 融合（1/(60+rank)）。
//   6 同实体多 chunk 聚合取 max（reciprocalRankFusion topN 已按实体聚合，取其最佳 chunk）。
//   7 decideMany 纵深防御：失配丢弃 + metric（正常 0）。
//   8 record 只用 visibleFields 重拼 snippet；matchedField 对 mask 字段 null（queryHydrate）。
//   9 §9 响应：mode 按实际执行路（hybrid|vector|fts|like）、degraded[]、scopeTruncated、policyVersion。
//
// 依赖注入：本文件不静态 import 会拉 db 单例的 authz/org 模块（subjects->org/authorization->db），
// scope/decide/hydrate 全部由 QueryRuntimeDeps 注入，规避测试收集期连错库（同 S5 教训）。

import {
  buildSearchQueryPlan,
  type SearchQueryPlan,
  type RequestedMode,
  type EntityTypeFilter,
} from "./queryPlan.js";
import { reciprocalRankFusion, type RouteHit } from "./rrf.js";
import { buildFieldGrantRows } from "./fieldGrant.js";
import { runRecall, type RouteRow, type RecallResult } from "./queryRecall.js";
import {
  emptySearchResponse,
  type QueryRuntimeDeps,
  type UnifiedSearchResponse,
  type UnifiedSearchItem,
  type EntityRef,
  type DegradedReason,
  type EffectiveMode,
} from "./queryTypes.js";

/** 按 §4.5 步骤 1b 决定实际要跑的路 + 降级标注；强制 vector 不可用时回退关键词，绝不报错。 */
function resolveExecution(
  plan: SearchQueryPlan,
  vectorOk: boolean,
  vectorReason: DegradedReason | null,
): { runFts: boolean; runLike: boolean; runVec: boolean; degraded: DegradedReason[] } {
  const degraded: DegradedReason[] = [];
  let runVec = plan.vector.enabled && vectorOk;
  let runFts = plan.routes.fts;
  let runLike = plan.routes.like;

  if (plan.requestedMode === "vector") {
    // 强制向量：向量不可用 -> 回退该词长本应走的关键词路（fts 或 like），并标注降级。
    if (!runVec) {
      if (vectorReason) degraded.push(vectorReason);
      runFts = plan.fts !== null;
      runLike = plan.like !== null;
    }
  } else if (plan.requestedMode === "fts") {
    runVec = false; // 强制关键词：短词走 LIKE，长词走 FTS，永不调 embedding。
  } else if (plan.vector.enabled && !vectorOk && vectorReason) {
    // auto：向量本想参与但不可用 -> 关键词照跑 + 标注（配置态 off/缺配置不给 reason，不标）。
    degraded.push(vectorReason);
  }
  return { runFts, runLike, runVec, degraded };
}

function routeToHits(rows: RouteRow[]): RouteHit[] {
  return rows.map((r) => ({ entityType: r.entityType, entityId: r.entityId, rank: r.rank }));
}

function effectiveMode(ran: RecallResult["ran"]): EffectiveMode {
  if (ran.vec && (ran.fts || ran.like)) return "hybrid";
  if (ran.vec) return "vector";
  if (ran.fts) return "fts";
  return "like";
}

/** 每实体选最佳 chunk：路序 vec>fts>like，路内取 rank 最小（即 RouteRow 序首）。 */
function bestChunks(recall: RecallResult): Map<string, EntityRef> {
  const best = new Map<string, { type: string; row: RouteRow }>();
  const consider = (rows: RouteRow[]) => {
    for (const r of rows) {
      const key = `${r.entityType}:${r.entityId}`;
      const cur = best.get(key);
      if (!cur) best.set(key, { type: r.entityType, row: r });
    }
  };
  // rank 已在每路内按结果顺序赋 1..n；首条即该路最佳。路优先级仅在实体首次出现时定序。
  consider(recall.vec);
  consider(recall.fts);
  consider(recall.like);
  const out = new Map<string, EntityRef>();
  for (const [key, v] of best) {
    out.set(key, {
      type: v.type as EntityRef["type"],
      entityId: v.row.entityId,
      nodeId: v.row.nodeId,
      best: {
        chunkKind: v.row.chunkKind, fieldId: v.row.fieldId,
        title: v.row.title, body: v.row.body, seq: v.row.seq,
      },
    });
  }
  return out;
}

/**
 * 执行一次统一检索（§4.5 九步）。全部依赖注入；不直接持有 prisma/store/provider 单例。
 * @param explain 采集三路 EXPLAIN QUERY PLAN（测试/S11 留证）。
 */
export async function executeUnifiedSearch(
  deps: QueryRuntimeDeps,
  input: {
    q: string;
    type?: EntityTypeFilter;
    mode?: RequestedMode;
    limit?: number;
  },
  explain = false,
): Promise<UnifiedSearchResponse> {
  const type: EntityTypeFilter = input.type ?? "all";
  const requestedMode: RequestedMode = input.mode ?? "auto";

  // 步骤 1：trim + 空 q 短路（§4.5 步骤 1 / §9）。
  const plan = buildSearchQueryPlan(input.q, { mode: requestedMode, type, limit: input.limit });
  const limit = plan.limits.finalTopN;
  if (plan.strategy === "browse") return emptySearchResponse(limit);

  // 步骤 2：M4 scope 收敛（kinds 映射；r 动作）。nodeIds 空直接空结果，不跑召回（EMPTY_SCOPE）。
  const scope = await deps.resolveScope();
  if (scope.nodeIds.length === 0) {
    return {
      items: [], total: 0, limit, mode: plan.strategy === "fts" ? "fts" : "like",
      degraded: [], scopeTruncated: scope.truncated, policyVersion: scope.policyVersion,
    };
  }

  // 步骤 4c 前置：await embed(q) 必须在任何 search.db TEMP 物化之前完成（硬红线 2：跨 await 不占临时表）。
  let queryVector: Buffer | null = null;
  let vectorReason: DegradedReason | null = null;
  if (plan.vector.enabled && deps.vector) {
    const out = await deps.vector.embedQuery(plan.query, plan.vector.entityTypeCodes);
    if (out.ok && out.blob) queryVector = out.blob;
    else vectorReason = out.reason ?? "vec_unavailable";
  } else if (plan.vector.enabled && !deps.vector) {
    vectorReason = null; // 配置态（off/cloud 缺配置）：不走向量且不算 degraded（§4.9）。
  }

  const exec = resolveExecution(plan, queryVector !== null, vectorReason);

  // 步骤 3+4：进入纯同步无 await 会话（唯一名 TEMP 表 + 三路召回）。
  // runRecall 按 fts/like 对象是否存在 + vector.enabled 决定路，故按 resolveExecution 的开关把
  // 不跑的关键词计划项置 null：强制 vector 成功 -> 只跑 vec（关键词两对象置 null）；强制 vector
  // 回退时 exec 已按词长把 runFts/runLike 置回（plan.fts/plan.like 仍在），此处天然补回。
  const effectivePlan: SearchQueryPlan = {
    ...plan,
    vector: { ...plan.vector, enabled: exec.runVec },
    fts: exec.runFts ? plan.fts : null,
    like: exec.runLike ? plan.like : null,
  };
  const grantRows = buildFieldGrantRows(new Set(scope.nodeIds), scope.maskedTableFields);
  const recall = runRecall(
    deps.store.db, effectivePlan, scope.nodeIds, grantRows,
    { queryVector: exec.runVec ? queryVector : null, explain },
  );

  // 步骤 5：RRF 融合（各路 1/(60+rank)，topN=limit）。
  const fusionInputs: Array<{ route: "fts" | "vec" | "like"; hits: RouteHit[] }> = [];
  if (recall.ran.fts) fusionInputs.push({ route: "fts", hits: routeToHits(recall.fts) });
  if (recall.ran.vec) fusionInputs.push({ route: "vec", hits: routeToHits(recall.vec) });
  if (recall.ran.like) fusionInputs.push({ route: "like", hits: routeToHits(recall.like) });
  const fused = reciprocalRankFusion(fusionInputs, { topN: limit });

  // 步骤 6：每实体最佳 chunk（用于 snippet/seq/fieldId）。
  const bestByEntity = bestChunks(recall);

  // 步骤 7：纵深防御 decideMany。失配丢弃 + metric（正常 0）。
  const candidateNodeIds = fused.map((f) => bestByEntity.get(`${f.entityType}:${f.entityId}`)!.nodeId);
  const allowedNodes = await deps.decideNodeIds(candidateNodeIds);
  const kept = fused.filter((f) => allowedNodes.has(bestByEntity.get(`${f.entityType}:${f.entityId}`)!.nodeId));
  const mismatch = fused.length - kept.length;
  // 步骤 7 metric：正常须为 0；非 0=scope 快照与决策不一致的 bug 信号（失配已丢弃）。
  deps.onMetric?.({
    decideMismatch: mismatch,
    routes: Object.entries(recall.ran).filter(([, v]) => v).map(([k]) => k),
  });

  // 步骤 8：主库装配 + mask 摘要重拼（record 只用可见字段；mask 字段 matchedField=null）。
  const refs: EntityRef[] = kept.map((f) => bestByEntity.get(`${f.entityType}:${f.entityId}`)!);
  const hydrated = await deps.hydrate(refs, scope.maskedTableFields);
  const hydById = new Map(hydrated.map((h) => [`${h.type}:${h.entityId}`, h]));

  const scoreByEntity = new Map(kept.map((f, i) => [`${f.entityType}:${f.entityId}`, { f, i }]));
  const items: UnifiedSearchItem[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.entityId}`;
    const h = hydById.get(key);
    const scoreEntry = scoreByEntity.get(key);
    if (!h || !scoreEntry) continue;
    const via = new Set(scoreEntry.f.routes.filter((r) => r === "fts" || r === "vec") as Array<"fts" | "vec">);
    items.push({
      type: ref.type, entityId: ref.entityId, nodeId: ref.nodeId,
      title: h.title, snippet: h.snippet,
      ...h.context,
      score: scoreEntry.f.score,
      matchedVia: [...via],
      chunkSeq: ref.type === "record" ? null : ref.best.seq,
      matchedField: h.matchedField,
    });
  }

  // 步骤 9：§9 响应（mode 按实际执行路）。
  return {
    items, total: items.length, limit,
    mode: effectiveMode(recall.ran),
    degraded: exec.degraded,
    scopeTruncated: scope.truncated,
    policyVersion: scope.policyVersion,
  };
}
