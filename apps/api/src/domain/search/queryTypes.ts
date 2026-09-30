// M5/S7 统一检索类型（query 编排三层共享；零 IO，可被纯函数与测试直接引用）。
//
// 权威依据：M5-implementation-plan.md §4.5（九步）、§9（v1 响应契约纲要）、§4.9（降级矩阵）。

import type { RequestedMode, EntityTypeFilter, SearchEntityType } from "./queryPlan.js";

/** §9 degraded[] 取值（只增；空数组=无降级）。 */
export type DegradedReason =
  | "vec_unavailable"
  | "embedding_unhealthy"
  | "dim_mismatch"
  | "search_store_recovering";

/** §9 实际执行路由决定的响应 mode（与请求 mode 不同：强制档回退后按实际执行路报告）。 */
export type EffectiveMode = "hybrid" | "vector" | "fts" | "like";

/** 单条命中实体（§9 items 元素）。record/doc/canvas 各自挂其定位上下文字段。 */
export interface UnifiedSearchItem {
  type: SearchEntityType;
  entityId: string;
  /** 实体挂载的 nav 节点 id（record=table 节点；doc/canvas=自身节点）。二次 decide 据此校验。 */
  nodeId: string;
  title: string;
  snippet: string;
  // record 定位上下文
  baseId?: string;
  baseName?: string;
  tableId?: string;
  tableName?: string;
  // doc/canvas 定位上下文
  kbId?: string;
  kbName?: string;
  docId?: string;
  score: number;
  /** 实体出现在哪些路（仅 "fts"|"vec"；短词 LIKE 路不入此标，由 mode:"like" 表达）。 */
  matchedVia: Array<"fts" | "vec">;
  /** doc/canvas 最佳命中块序号；record 无块序为 null。 */
  chunkSeq: number | null;
  /** 命中字段名；identity/无字段命中为 null，被 mask 字段必须为 null（§4.7 规则 6）。 */
  matchedField: string | null;
}

export interface UnifiedSearchResponse {
  items: UnifiedSearchItem[];
  total: number;
  limit: number;
  mode: EffectiveMode;
  degraded: DegradedReason[];
  scopeTruncated: boolean;
  policyVersion: number;
}

/** 空 q 短路响应（§4.5 步骤 1 / §9：{items:[],mode:"like"}，不跑 scope/召回）。 */
export function emptySearchResponse(limit: number): UnifiedSearchResponse {
  return {
    items: [], total: 0, limit, mode: "like", degraded: [],
    scopeTruncated: false, policyVersion: 0,
  };
}

export interface SearchRequestInput {
  /** 原始（未 trim）查询词；trim 在编排内做。 */
  q: string;
  userId: string;
  /** all|record|doc|canvas（默认 all）。 */
  type?: EntityTypeFilter;
  /** auto|fts|vector（默认 auto）。 */
  mode?: RequestedMode;
  /** 实体聚合上限，默认 20、硬上限 50（queryPlan clamp）。 */
  limit?: number;
}

/** 一个 search.db 连接所需的最小形状（真实 SearchStore 结构化满足；不静态绑实现，便于测试）。 */
export interface SearchDbLike {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
}

/** query 编排的注入依赖（全部显式注入：store/provider/时钟不静态单例，测试可确定性替换）。 */
export interface QueryRuntimeDeps {
  /** 已打开的 search.db（on/shadow 请求路径惰性 getSearchStore；测试传临时 store）。 */
  store: { db: SearchDbLike; vecAvailable: boolean; filePath: string };
  /**
   * 向量路门控与执行者：null=配置态不走向量（mode=off/cloud 缺配置，不算 degraded）。
   * 提供时在 scope 之后、物化之前被调用一次算查询向量；抛错按 embedding_unhealthy 降级。
   */
  vector: QueryVectorGate | null;
  /** 纵深防御二次决策（§4.5 步骤 7）；返回允许的 nodeId 集（正常应等于召回集）。 */
  decideNodeIds: (nodeIds: string[]) => Promise<ReadonlySet<string>>;
  /** record/doc/canvas 命中实体的主库数据装配（标题/上下文字段/可见字段重拼 snippet）。 */
  hydrate: (refs: EntityRef[], masked: Record<string, readonly string[]>) => Promise<HydratedEntity[]>;
  /** scope 收敛（M4 冻结入口）；编排只消费其返回，不重算权限。 */
  resolveScope: () => Promise<ScopeLike>;
  /** 诊断回调（decide 失配数等；生产接 metric，测试断言）。 */
  onMetric?: (m: QueryMetric) => void;
}

/** 查询向量请求：text=文本查询；images=可选图片（data:image/... 或 https），带图即"以图搜图"。 */
export interface VectorEmbedRequest {
  text: string;
  images?: readonly string[];
}

export interface QueryVectorGate {
  /** dim 与 index_meta.embeddingDim 一致性由实现内判；返回 null=该路不可用（理由见 reason）。 */
  embedQuery(req: VectorEmbedRequest, typeCodes: readonly number[]): Promise<VectorQueryOutcome>;
}

export interface VectorQueryOutcome {
  ok: boolean;
  /** ok=false 时的降级原因（embedding_unhealthy/dim_mismatch/vec_unavailable）。 */
  reason?: DegradedReason;
  /** 查询向量字节（Float32 BLOB）；ok=true 非空。 */
  blob?: Buffer;
}

export interface ScopeLike {
  nodeIds: string[];
  truncated: boolean;
  policyVersion: number;
  maskedTableFields: Record<string, readonly string[]>;
}

export interface EntityRef {
  type: SearchEntityType;
  entityId: string;
  nodeId: string;
  /** 该实体聚合计分用的最佳 chunk（用于 snippet/seq/fieldId）。 */
  best: { chunkKind: "identity" | "field"; fieldId: string | null; title: string; body: string; seq: number };
}

export interface HydratedEntity {
  type: SearchEntityType;
  entityId: string;
  title: string;
  snippet: string;
  context: {
    baseId?: string; baseName?: string; tableId?: string; tableName?: string;
    kbId?: string; kbName?: string; docId?: string;
  };
  matchedField: string | null;
}

export interface QueryMetric {
  /** 二次 decide 丢弃的失配实体数（正常 0；非 0=scope 快照与决策不一致的 bug 信号）。 */
  decideMismatch?: number;
  /** 实际执行的路（观测用）。 */
  routes?: string[];
}
