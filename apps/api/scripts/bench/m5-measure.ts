// apps/api/scripts/bench/m5-measure.ts
// M5/S13 测量原语：单轮混合检索（FTS+vec → RRF/boost）与分阶段耗时归因。
// 从 m5-gate.ts 抽出以守住单文件 ≤300 行；无 IO 之外副作用（只读 search.db 会话）。

import { performance } from "node:perf_hooks";
import { runRecall } from "../../src/domain/search/queryRecall.js";
import { reciprocalRankFusion, type RouteHit } from "../../src/domain/search/rrf.js";
import type { SearchQueryPlan } from "../../src/domain/search/queryPlan.js";
import type { SearchDbLike } from "../../src/domain/search/queryTypes.js";

export interface RoundTimings { ms: number; fts: number; vec: number; fused: number }
export interface StageTimings { scopeMs: number; ftsMs: number; vecMs: number; fusionMs: number }

type Db = Parameters<typeof runRecall>[0];
type Grants = Array<{ tableNodeId: string; fieldId: string }>;

function toHits(rows: Array<{ entityType: string; entityId: string; rank: number; title: string }>): RouteHit[] {
  return rows.map((r) => ({ entityType: r.entityType, entityId: r.entityId, rank: r.rank, title: r.title }));
}

/** 单轮混合检索：runRecall（FTS+vec）→ RRF 融合（含标题 boost），全程无 await（同步段）。 */
export function oneHybridRound(db: Db, plan: SearchQueryPlan, scope: string[], grants: Grants, qvec: Buffer): RoundTimings {
  const t = performance.now();
  const recall = runRecall(db as SearchDbLike, plan, scope, grants, { queryVector: qvec });
  const inputs: Array<{ route: "fts" | "vec"; hits: RouteHit[] }> = [];
  if (recall.ran.fts) inputs.push({ route: "fts", hits: toHits(recall.fts) });
  if (recall.ran.vec) inputs.push({ route: "vec", hits: toHits(recall.vec) });
  const fused = reciprocalRankFusion(inputs, { topN: plan.limits.finalTopN, titleQuery: plan.query });
  return { ms: performance.now() - t, fts: recall.fts.length, vec: recall.vec.length, fused: fused.length };
}

/** 分阶段单次耗时（诊断）：scope 物化 / FTS / vec / 融合，定位超线性成本所在。 */
export function measureStages(db: Db, plan: SearchQueryPlan, scope: string[], grants: Grants, qvec: Buffer): StageTimings {
  const t = (fn: () => void): number => { const s = performance.now(); fn(); return performance.now() - s; };
  const emptyPlan: SearchQueryPlan = { ...plan, fts: null, like: null, vector: { ...plan.vector, enabled: false } };
  const scopeMs = t(() => { runRecall(db as SearchDbLike, emptyPlan, scope, grants, {}); });
  const ftsPlan: SearchQueryPlan = { ...plan, vector: { ...plan.vector, enabled: false } };
  const ftsMs = t(() => { runRecall(db as SearchDbLike, ftsPlan, scope, grants, {}); });
  const vecPlan: SearchQueryPlan = { ...plan, fts: null, like: null };
  const vecMs = t(() => { runRecall(db as SearchDbLike, vecPlan, scope, grants, { queryVector: qvec }); });
  const fusionMs = t(() => {
    const mk = (p: string): RouteHit[] => Array.from({ length: 100 }, (_, i) => ({ entityType: "doc", entityId: `${p}${i}`, rank: i + 1 }));
    reciprocalRankFusion(
      [{ route: "fts", hits: mk("d") }, { route: "vec", hits: mk("v") }],
      { topN: plan.limits.finalTopN, titleQuery: plan.query },
    );
  });
  return { scopeMs, ftsMs, vecMs, fusionMs };
}
