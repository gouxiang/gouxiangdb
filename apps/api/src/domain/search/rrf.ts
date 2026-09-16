// M5/S3 Reciprocal Rank Fusion 纯融合层（零 IO / 零接线，表驱动单测见 __tests__/rrf.test.ts）。
//
// 权威依据：docs/planning/phase2/M5-implementation-plan.md
//   - §4.5 步骤 5：每路 score += 1/(60+rank)，多路（fts / vec / like）融合后再做实体聚合。
//   - §0.1-3 先收敛后召回：本层只融合【已经 scope/field_grant 收敛过】的路内命中，
//     本文件不做任何权限判定、不查库、不发网络请求。
//
// 确定性（可重放）要求：
//   - 同分 tie-break：先 entityType 字典序，再 entityId 字典序——与输入路序、命中序无关；
//   - 浮点求和按 (route, rank) 固定序累加，避免输入乱序导致 ULP 级差异；
//   - 同一路内同一实体重复出现只保留最靠前名次（最小 rank）。

/** 召回路名（§4.5：FTS trigram / vec KNN / 短词 LIKE；调用层也可传自定义名）。 */
export type FusionRoute = "fts" | "vec" | "like" | (string & {});

/** 单路内的一条命中。rank 为 1 基名次；缺省时按该路 hits 数组下标 +1 计名。 */
export interface RouteHit {
  entityType: string;
  entityId: string;
  rank?: number;
  /** 路内原始相关性分（bm25/distance 等），仅透传，不参与 RRF 计分。 */
  rawScore?: number;
}

/** 一路召回输入。weight 缺省 1（等权）；空路（hits=[]）合法，贡献为零。 */
export interface FusionInput {
  route: FusionRoute;
  hits: readonly RouteHit[];
  weight?: number;
}

export interface RouteContribution {
  route: string;
  rank: number;
  weight: number;
  contribution: number;
}

export interface FusedCandidate {
  entityType: string;
  entityId: string;
  /** 加权 RRF 总分：sum_r weight_r * 1/(k + rank_r)。 */
  score: number;
  /** 实体在哪些路出现（按路名字典序，稳定输出）。 */
  routes: string[];
  /** 各路贡献明细分（按路名排序）。 */
  contributions: RouteContribution[];
  /** 各路透传的最靠前名次对应的原始分。 */
  rawScores: Record<string, number>;
}

export interface RrfOptions {
  /** RRF 平滑常数，典型 60（§4.5 步骤 5）。 */
  k?: number;
  /** 路权重（默认等权 1）；可被单路 input.weight 覆盖。 */
  weights?: Readonly<Record<string, number>>;
  /** 融合后截断数；缺省不截断。 */
  topN?: number;
}

const DEFAULT_K = 60;

function entityKey(entityType: string, entityId: string): string {
  return `${entityType}\u0000${entityId}`;
}

interface Accum {
  entityType: string;
  entityId: string;
  /** route -> 该路最佳（最小）rank 与该名次透传的 rawScore。 */
  perRoute: Map<string, { rank: number; rawScore?: number }>;
}

/**
 * 加权 Reciprocal Rank Fusion。
 *
 * 纯函数：不修改输入、无副作用；同输入（含乱序）必产出字节级一致的输出序列。
 */
export function reciprocalRankFusion(
  inputs: readonly FusionInput[],
  options: RrfOptions = {},
): FusedCandidate[] {
  const k = options.k ?? DEFAULT_K;
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error("rrf k must be a positive finite number");
  }
  const globalWeights = options.weights ?? {};

  // 逐路解析生效权重（单路 weight 优先；同名路以输入序后者为准，行为确定）。
  const routeWeight = new Map<string, number>();
  for (const input of inputs) {
    const w = input.weight ?? globalWeights[input.route as string] ?? 1;
    if (!Number.isFinite(w) || w < 0) {
      throw new Error(`rrf weight for route "${input.route}" must be a non-negative finite number`);
    }
    routeWeight.set(input.route as string, w);
  }

  const acc = new Map<string, Accum>();
  for (const input of inputs) {
    const route = input.route as string;
    for (let i = 0; i < input.hits.length; i++) {
      const hit = input.hits[i];
      if (!hit || typeof hit.entityType !== "string" || typeof hit.entityId !== "string") {
        throw new Error("rrf hit requires string entityType and entityId");
      }
      const rank = hit.rank ?? i + 1;
      if (!Number.isInteger(rank) || rank <= 0) {
        throw new Error("rrf hit rank must be a positive 1-based integer");
      }
      const key = entityKey(hit.entityType, hit.entityId);
      let cur = acc.get(key);
      if (!cur) {
        cur = { entityType: hit.entityType, entityId: hit.entityId, perRoute: new Map() };
        acc.set(key, cur);
      }
      const existing = cur.perRoute.get(route);
      if (existing) {
        // 同路重复：只保留最靠前名次及其透传 rawScore，名次相同则后者不覆盖。
        if (rank < existing.rank) {
          existing.rank = rank;
          existing.rawScore = hit.rawScore;
        }
        continue;
      }
      cur.perRoute.set(route, { rank, rawScore: hit.rawScore });
    }
  }

  const candidates: FusedCandidate[] = [];
  for (const item of acc.values()) {
    // 固定序累加：按 (route 名, rank) 排序，消除输入路序/命中序对浮点结果的影响。
    const parts = [...item.perRoute.entries()]
      .map(([route, v]) => ({ route, rank: v.rank, rawScore: v.rawScore }))
      .sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : a.rank - b.rank));

    let score = 0;
    const contributions: RouteContribution[] = [];
    const routes: string[] = [];
    const rawScores: Record<string, number> = {};
    for (const part of parts) {
      const weight = routeWeight.get(part.route) ?? 1;
      const contribution = weight / (k + part.rank);
      score += contribution;
      routes.push(part.route);
      contributions.push({ route: part.route, rank: part.rank, weight, contribution });
      if (part.rawScore !== undefined) rawScores[part.route] = part.rawScore;
    }
    candidates.push({
      entityType: item.entityType,
      entityId: item.entityId,
      score,
      routes,
      contributions,
      rawScores,
    });
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.entityType !== b.entityType) return a.entityType < b.entityType ? -1 : 1;
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
  });

  const topN = options.topN;
  if (topN !== undefined) {
    if (!Number.isInteger(topN) || topN < 0) {
      throw new Error("rrf topN must be a non-negative integer");
    }
    return candidates.slice(0, topN);
  }
  return candidates;
}
