// M5/S3 检索查询计划纯函数层（零 IO / 零接线，表驱动单测见 __tests__/queryPlan.test.ts）。
//
// 权威依据：docs/planning/phase2/M5-implementation-plan.md
//   - §0.2 H9：FTS5 trigram 中文/拉丁 >=3 码点才命中；按【码点长度】分流：>=3 走 MATCH，
//     <3 回参数化 LIKE；空查询走"全 identity 浏览/有界"。
//   - §4.5 步骤 4a/4b/4c：用户输入一律参数绑定（MATCH 用双引号短语、LIKE 转义 % _ \），
//     allowed 谓词 = chunkKind='identity' OR EXISTS(temp_field_grant 命中)；KNN 必带 k/LIMIT；
//     entityType 白名单整数映射 1=record 2=doc 3=canvas（§4.2，绑定时由 S7 转 BigInt）。
//
// 本文件只产出【计划数据结构 + 参数化 SQL 片段 + 绑定参数数组】，不执行任何 SQL、不查库。

export type SearchEntityType = "record" | "doc" | "canvas";

/** vec_chunks.entityType 整数映射（§4.2）。 */
export const ENTITY_TYPE_CODE: Readonly<Record<SearchEntityType, number>> = {
  record: 1,
  doc: 2,
  canvas: 3,
};

export const ALL_ENTITY_TYPES: readonly SearchEntityType[] = ["record", "doc", "canvas"];

/** 关键词策略：fts=trigram MATCH；like=短词参数化 LIKE；browse=空查询的 identity 有界浏览。 */
type KeywordStrategy = "fts" | "like" | "browse";

/** 请求侧 mode（§4.5 步骤 1b；降级到实际可用路由由 S7 执行，本层只如实规划）。 */
export type RequestedMode = "auto" | "fts" | "vector";

export type EntityTypeFilter = "all" | SearchEntityType;

interface LikePlan {
  /** 已转义并包 % 的模式串；两个绑定位同值（title/body）。 */
  sql: string;
  bindings: string[];
  pattern: string;
}

interface FtsPlan {
  /** 双引号短语，内部双引号已翻倍；绑定给 MATCH 右值。 */
  sql: string;
  bindings: string[];
  phrase: string;
}

interface BrowsePlan {
  /** 空查询只浏览身份 chunk（绝不扫 field body），有界 LIMIT。 */
  identityOnly: true;
  bounded: true;
  sql: string;
  bindings: number[];
}

/**
 * allowed 谓词（§4.5 步骤 4a / §4.7 第 4-5 点）的纯数据描述 + 参数化 SQL 片段。
 * 片段内零用户输入、零内插；表级收敛由 S7 的 temp_scope INNER JOIN 承担，field 级三分支：
 *   1. identity chunk 恒可见；
 *   2. field chunk：该表在 temp_field_grant 无任何行（无 mask；§4.5 步骤 3
 *      "空表代表无字段收窄"）-> 可见；
 *   3. 否则须命中该主体白名单行 (tableNodeId,fieldId)。
 * 别名约定：chunks c（与 §4.5 SQL 一致）。
 */
interface AllowedPredicate {
  identityAlwaysVisible: true;
  grantTable: "temp_field_grant";
  sql: string;
  bindings: never[];
}

interface VectorRoutePlan {
  enabled: boolean;
  /** H4 铁律：KNN 必须带 k（= LIMIT），无上限的计划不允许产出。 */
  k: number;
  entityTypeCodes: number[];
  /** 纯以图搜图（无文本、仅图片）：无关键词路，只规划向量 KNN。 */
  imageOnly: boolean;
}

export interface SearchQueryPlan {
  /** trim 后的原始查询词。 */
  query: string;
  /** 码点数（Array.from/spread，正确处理中文代理对与 emoji；非 String.length）。 */
  codepointLength: number;
  strategy: KeywordStrategy;
  requestedMode: RequestedMode;
  /** 本计划实际请求的路（能力与门/降级判定在 S7，不在此层）。 */
  routes: { fts: boolean; like: boolean; vector: boolean; browse: boolean };
  fts: FtsPlan | null;
  like: LikePlan | null;
  browse: BrowsePlan | null;
  vector: VectorRoutePlan;
  allowed: AllowedPredicate;
  /** 实体类型白名单（名 + vec0 整数码）。 */
  entityTypes: { names: SearchEntityType[]; codes: number[] };
  /** 每路召回上限与最终聚合上限（§4.5 各路 LIMIT 100、出口固定 top20/limit<=50）。 */
  limits: { perRoute: number; finalTopN: number };
}

interface BuildPlanOptions {
  mode?: RequestedMode;
  type?: EntityTypeFilter;
  /** 出口最终实体聚合上限，默认 20，硬上限 50（§9）。 */
  limit?: number;
  /** 每路召回上限，默认 100（§4.5 步骤 4）。 */
  perRoute?: number;
  /** 以图搜图：是否携带至少一张可用图片（用于无文本时仍规划向量路）。 */
  hasImages?: boolean;
}

const DEFAULT_PER_ROUTE = 100;
const DEFAULT_FINAL_TOP_N = 20;
const MAX_FINAL_TOP_N = 50;
/** H9：trigram >=3 码点才命中。 */
export const FTS_CODEPOINT_MIN = 3;

/** trim 后按码点计数（中文按字、emoji/代理对按单一码点；ZWJ 序列按其码点数）。 */
export function codepointLength(s: string): number {
  return Array.from(s).length;
}

export function normalizeQuery(raw: string): string {
  return (raw ?? "").trim();
}

/**
 * 转义 LIKE 字面量：\ % _ 前加反斜杠（配合 LIKE ... ESCAPE '\'）。
 * 只产出转义后的【字面量】；调用层负责包通配符与参数绑定，本函数不拼执行 SQL。
 */
export function escapeLikeLiteral(literal: string): string {
  return literal.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 子串模式：% + 已转义字面量 + %（含 % _ 的输入按字面量匹配，不构成通配）。 */
export function buildLikePattern(literal: string): string {
  return `%${escapeLikeLiteral(literal)}%`;
}

/**
 * FTS5 MATCH 短语：整体包双引号，内部双引号翻倍（FTS5 引号转义）。
 * 短语不被解释为 AND/OR/NEAR 等操作符；单引号/分号/-- 等在绑定参数内无 SQL 语义。
 */
export function buildFtsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

/**
 * allowed 谓词（§4.5 步骤 4a / §4.7 第 5 点）：
 *   c.chunkKind = 'identity'
 *   OR NOT EXISTS(SELECT 1 FROM temp_field_grant g0 WHERE g0.tableNodeId = c.nodeId)
 *   OR EXISTS(SELECT 1 FROM temp_field_grant g
 *             WHERE g.tableNodeId = c.nodeId AND g.fieldId = c.fieldId)
 * 三分支语义（§4.5 步骤 3「空表代表无字段收窄」+ §4.7 规则 4）：identity 恒可见；
 * scope 内无 mask 的表（无该表任何授权行）全部 field chunk 可见；有 mask 表仅白名单字段可见。
 * 表级不可见由 S7 的 temp_scope INNER JOIN 先行剔除（规则 7），片段无用户输入、无绑定。
 * 别名约定：chunks c / fts body 别名 f（与 §4.5 步骤 4a/4b SQL 一致）。
 */
export function buildAllowedPredicate(): AllowedPredicate {
  return {
    identityAlwaysVisible: true,
    grantTable: "temp_field_grant",
    sql:
      "(c.chunkKind = 'identity' " +
      "OR NOT EXISTS (SELECT 1 FROM temp_field_grant g0 WHERE g0.tableNodeId = c.nodeId) " +
      "OR EXISTS (SELECT 1 FROM temp_field_grant g " +
      "WHERE g.tableNodeId = c.nodeId AND g.fieldId = c.fieldId))",
    bindings: [],
  };
}

function resolveEntityTypes(filter: EntityTypeFilter): { names: SearchEntityType[]; codes: number[] } {
  if (filter === "all") {
    return { names: [...ALL_ENTITY_TYPES], codes: ALL_ENTITY_TYPES.map((t) => ENTITY_TYPE_CODE[t]) };
  }
  if ((ALL_ENTITY_TYPES as readonly string[]).includes(filter)) {
    return { names: [filter], codes: [ENTITY_TYPE_CODE[filter]] };
  }
  throw new Error(`unknown entity type filter: ${String(filter)}`);
}

function clampTopN(limit: number | undefined): number {
  const n = limit ?? DEFAULT_FINAL_TOP_N;
  if (!Number.isInteger(n) || n <= 0) throw new Error("limit must be a positive integer");
  return Math.min(n, MAX_FINAL_TOP_N);
}

/**
 * 由查询词与请求选项产出确定性检索计划（纯函数）。
 * 不触库、不发网、不读配置；所有用户文本只经 bindings 出现，SQL 片段零字符串内插。
 */
export function buildSearchQueryPlan(rawQuery: string, options: BuildPlanOptions = {}): SearchQueryPlan {
  const query = normalizeQuery(rawQuery);
  const len = codepointLength(query);
  const requestedMode: RequestedMode = options.mode ?? "auto";
  if (requestedMode !== "auto" && requestedMode !== "fts" && requestedMode !== "vector") {
    throw new Error(`unknown requested mode: ${String(requestedMode)}`);
  }
  const perRoute = options.perRoute ?? DEFAULT_PER_ROUTE;
  if (!Number.isInteger(perRoute) || perRoute <= 0) {
    throw new Error("perRoute must be a positive integer");
  }
  const entityTypes = resolveEntityTypes(options.type ?? "all");

  const strategy: KeywordStrategy = len === 0 ? "browse" : len >= FTS_CODEPOINT_MIN ? "fts" : "like";
  const allowed = buildAllowedPredicate();
  const fts: FtsPlan | null =
    strategy === "fts"
      ? {
          sql: "fts_chunks MATCH ?",
          bindings: [buildFtsPhrase(query)],
          phrase: buildFtsPhrase(query),
        }
      : null;

  const like: LikePlan | null =
    strategy === "like"
      ? (() => {
          const pattern = buildLikePattern(query);
          return {
            sql: "(c.title LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\')",
            bindings: [pattern, pattern],
            pattern,
          };
        })()
      : null;

  const browse: BrowsePlan | null =
    strategy === "browse"
      ? {
          identityOnly: true,
          bounded: true,
          sql: "c.chunkKind = 'identity' ORDER BY c.updatedAt DESC LIMIT ?",
          bindings: [perRoute],
        }
      : null;

  // vector 路：有文本按 mode 规划；纯以图搜图（无文本但带图）也规划向量 KNN。
  // 纯图仅在 auto/vector 下启用；强制 fts 不走向量。
  const imageOnly = len === 0 && options.hasImages === true;
  const vectorEnabled =
    (len > 0 || imageOnly) &&
    (requestedMode === "auto" || requestedMode === "vector");
  const vector: VectorRoutePlan = {
    enabled: vectorEnabled,
    k: perRoute,
    entityTypeCodes: entityTypes.codes,
    imageOnly,
  };

  const routes = {
    fts: fts !== null && requestedMode !== "vector",
    like: like !== null && requestedMode !== "vector",
    vector: vectorEnabled,
    browse: browse !== null,
  };

  return {
    query,
    codepointLength: len,
    strategy,
    requestedMode,
    routes,
    fts,
    like,
    browse,
    vector,
    allowed,
    entityTypes,
    limits: { perRoute, finalTopN: clampTopN(options.limit) },
  };
}
