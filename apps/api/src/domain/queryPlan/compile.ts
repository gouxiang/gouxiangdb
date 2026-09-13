// apps/api/src/domain/queryPlan/compile.ts
// M1/S6 queryPlan 纯编译器（无 DB 依赖）：把 ViewConfig.filters(FilterNode) + sorts[]
// 编译成三部分：
//   - physical：可下推到 sidecar（record_field_index）的参数化 WHERE 片段（在别名 r 上，
//     不含前导 AND），值全部 ? 绑定；
//   - residual：不能下推、必须在候选集上跑内存 evalFilter 的 FilterNode 子树；
//   - sortPush：可下推的 valueNum 排序（valueText 因 SQLite BINARY 与 JS zh-CN numeric
//     排序不一致，M1 保守不下推）。
//
// 正确性纪律（与 shared filter.ts evalFilter 逐行等价，宁可多回退也不撒谎）：
//   1) AND 可部分下推（物理子树下推、残余子树留内存）；OR/NOT 只要混入任一不可下推叶，
//      整棵子树回退内存——OR 无法安全部分下推。所有 OR 片段自带括号（不依赖 S2 anded）。
//   2) 互补对用 NOT 折叠：neq=NOT eq、isNot=NOT is、isNoneOf=NOT isAnyOf、isNotEmpty=NOT isEmpty。
//      checked/unchecked 非互补（truthy 2 两者皆 false），各自生成；unchecked 含空值。
//   3) autoNumber 任何算符/排序都回退（sidecar 文本 vs hydrate 计算编号语义不一）。
//   4) 数字/日期范围算符仅当【字面量能转数值】才下推；否则回退（evalFilter 在 toNumber=null
//      时退回文本比较，无法用 valueNum 表达）。
//   5) LIKE 仅短文本四类型，转义 \ % _ 并 ESCAPE '\\'，防通配注入。
//   6) 排序空值恒排后（ORDER BY (v IS NULL)），tie-break 固定 createdAt ASC,id ASC（与
//      sortRows 稳定排序的输入序一致），不随用户方向翻转。

import type { FilterNode, FilterCondition, SortSpec } from "@gx/shared-types";
import type { SqlBindValue } from "../../db/rawRead.js";

/** 编译所需的最小字段描述（FieldMeta 的子集）。 */
export interface PlanField {
  id: string;
  type: string;
  isPrimary?: boolean;
}

export interface SortJoin {
  fieldId: string;
  /** 关联子查询别名（s0/s1…，由编译器固定）。 */
  alias: string;
  direction: "asc" | "desc";
}

export interface CompiledPlan {
  /** 物理 WHERE 片段（别名 r），全物理时为 null 表示无约束。 */
  filterSql: string | null;
  filterParams: SqlBindValue[];
  /** 留待内存 evalFilter 的子树；null 表示过滤可全下推（或本无过滤）。 */
  residual: FilterNode | null;
  /** 可下推排序的 join 描述（已含全部 sorts）；null 表示排序须内存。 */
  sortJoins: SortJoin[] | null;
  /** 过滤是否全下推（无 residual）。 */
  filtersFullyPhysical: boolean;
}

const SHORT_TEXT = new Set(["singleLineText", "email", "url", "phone"]);
const NUM_LIKE = new Set(["number", "currency", "percent", "duration", "rating"]);
const DATE_LIKE_TYPES = new Set(["date", "datetime"]);
const DATE_LIKE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** 与 shared filter.ts toNumber 同构：数字直转，日期形态按毫秒，否则 null。 */
function literalNum(lit: string): number | null {
  if (lit === "") return null;
  const n = Number(lit);
  if (Number.isFinite(n)) return n;
  if (DATE_LIKE.test(lit)) {
    const ts = Date.parse(lit);
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

/** LIKE 转义：默认转义符反斜杠，转义 \ % _（绑定参数，不拼串）。 */
function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function splitMulti(v: string): string[] {
  return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

interface Builder {
  tableId: string;
  params: SqlBindValue[];
  byId: Map<string, PlanField>;
  bind(v: SqlBindValue): string;
}

/** 单条件 → sidecar 相关 EXISTS 内层谓词（别名 x）；null = 不可下推。 */
function compileLeaf(b: Builder, c: FilterCondition): string | null {
  if (c.valueType === "field") return null; // 跨列比较恒回退
  const f = b.byId.get(c.fieldId);
  if (!f) return null;
  const t = f.type;
  const op = c.op;

  // autoNumber 恒回退（含 isEmpty）：sidecar 存的是原始空（hydrate 却现算编号），
  // 任何谓词都与内存语义不一致。
  if (t === "autoNumber") return null;

  // 公共：EXISTS(SELECT 1 FROM rfi x WHERE x.recordId=r.id AND tableId AND fieldId AND <inner>)
  // 参数绑定顺序固定为 tableId → fieldId → inner 中的值占位（与 SQL 文本中 ? 出现顺序一致）。
  const exists = (inner: string, extra: SqlBindValue[] = []): string => {
    b.bind(b.tableId);
    b.bind(c.fieldId);
    for (const v of extra) b.bind(v);
    return (
      `EXISTS(SELECT 1 FROM "record_field_index" x ` +
      `WHERE x."recordId"=r."id" AND x."tableId"=? AND x."fieldId"=? AND ${inner})`
    );
  };
  const notExists = (inner: string, extra: SqlBindValue[] = []): string => `NOT ${exists(inner, extra)}`;

  // ---- 空值（所有可索引物理类型通用）----
  if (op === "isEmpty") {
    if (!isIndexedPlanField(f)) return null;
    return exists(`x."isNull"=1`);
  }
  if (op === "isNotEmpty") {
    if (!isIndexedPlanField(f)) return null;
    return exists(`x."isNull"=0`);
  }

  // ---- 数值族（valueNum）----
  if (NUM_LIKE.has(t)) {
    const numOps: Record<string, string> = { eq: "=", neq: "!=", gt: ">", lt: "<", gte: ">=", lte: "<=" };
    const sym = numOps[op];
    if (!sym) return null;
    const n = literalNum(c.value);
    if (n === null) return null; // 字面量非数值 → evalFilter 退回文本比较
    const inner = `x."valueNum" ${sym} ?`;
    // neq 用 NOT 折叠（与 evalFilter 数值不等严格一致；null 行不命中 =/NOT EXISTS 为真，
    // 与 evalFilter a=null 时退文本不等的真值在数值字面量下一致）。
    return op === "neq" ? notExists(`x."valueNum" = ?`, [n]) : exists(inner, [n]);
  }

  // ---- 日期族：is/isNot 走 valueText 等值；gt/lt/gte/lte 走 valueNum 毫秒 ----
  if (DATE_LIKE_TYPES.has(t)) {
    if (op === "is") return exists(`x."valueText" = ?`, [c.value]);
    if (op === "isNot") return notExists(`x."valueText" = ?`, [c.value]);
    const numOps: Record<string, string> = { gt: ">", lt: "<", gte: ">=", lte: "<=" };
    const sym = numOps[op];
    if (!sym) return null;
    const n = literalNum(c.value);
    if (n === null) return null;
    return exists(`x."valueNum" ${sym} ?`, [n]);
  }

  // ---- checkbox：checked=valueNum 1；unchecked=valueNum 0 或空（evalFilter unchecked 含空）----
  if (t === "checkbox") {
    if (op === "checked") return exists(`x."valueNum"=1`);
    if (op === "unchecked") return exists(`(x."isNull"=1 OR x."valueNum"=0)`);
    return null;
  }

  // ---- 单选（valueText 标量）----
  if (t === "singleSelect") {
    if (op === "is") return exists(`x."valueText" = ?`, [c.value]);
    if (op === "isNot") return notExists(`x."valueText" = ?`, [c.value]);
    if (op === "isAnyOf" || op === "isNoneOf") {
      const items = splitMulti(c.value);
      if (items.length === 0) return null; // evalFilter 空集 any=false/none=true，保守回退
      const inList = items.map(() => "?").join(",");
      const inner = `x."isNull"=0 AND x."valueText" IN (${inList})`;
      return op === "isNoneOf" ? notExists(inner, items) : exists(inner, items);
    }
    return null;
  }

  // ---- 多选（多行）：isAnyOf=EXISTS IN；isNoneOf=NOT EXISTS；contains 子串语义回退 ----
  if (t === "multiSelect") {
    if (op === "isAnyOf" || op === "isNoneOf") {
      const items = splitMulti(c.value);
      if (items.length === 0) return null;
      const inList = items.map(() => "?").join(",");
      const inner = `x."isNull"=0 AND x."valueText" IN (${inList})`;
      return op === "isNoneOf" ? notExists(inner, items) : exists(inner, items);
    }
    return null;
  }

  // ---- 文本族（短文本四类型 + 主字段）----
  const textEq = SHORT_TEXT.has(t) || (f.isPrimary === true && isIndexedPlanField(f));
  if (textEq) {
    // is/isNot 为大小写敏感严格相等（同内存 text===cmpText），BINARY = 对齐。
    if (op === "is") return exists(`x."valueText" = ?`, [c.value]);
    if (op === "isNot") return notExists(`x."valueText" = ?`, [c.value]);
    // 短文本 isAnyOf/isNoneOf：内存 arrayContainsAny 大小写【不敏感】，SQL IN 默认
    // BINARY 区分大小写，自由文本可能有大小写差异 → 回退内存（仅 optionId 选择列可安全 IN）。
    // LIKE 仅短文本四类型（主字段若为 longText，contains 按规格回退）。
    if (SHORT_TEXT.has(t) && (op === "contains" || op === "startsWith" || op === "endsWith")) {
      // 空 pattern：内存里 '' 是任意串（含空串/null 文本化后）的子串/前缀/后缀，恒真，
      // 无法用 isNull=0 的 LIKE 表达（会漏掉空值行）→ 回退内存。
      if (c.value === "") return null;
      const pat =
        op === "contains" ? `%${escapeLike(c.value)}%`
        : op === "startsWith" ? `${escapeLike(c.value)}%`
        : `%${escapeLike(c.value)}`;
      return exists(`x."isNull"=0 AND x."valueText" LIKE ? ESCAPE '\\'`, [pat]);
    }
    return null;
  }

  return null;
}

/** 与 policy.isIndexedField 同口径的最小判定（autoNumber 入索引但不参与下推）。 */
function isIndexedPlanField(f: PlanField): boolean {
  const t = f.type;
  if (SHORT_TEXT.has(t) || t === "autoNumber") return true;
  if (NUM_LIKE.has(t) || DATE_LIKE_TYPES.has(t)) return true;
  if (t === "checkbox" || t === "singleSelect" || t === "multiSelect") return true;
  if (f.isPrimary) {
    // 主字段非计算/非系统/非关联标量即入索引（同 policy.isPhysicalScalar）。
    const excluded = ["links", "subtable", "lookup", "rollup", "count", "formula", "tabs",
      "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy"];
    return !excluded.includes(t);
  }
  return false;
}

interface NodeResult {
  sql: string | null;
  residual: FilterNode | null;
}

function compileNode(b: Builder, node: FilterNode | null | undefined): NodeResult {
  if (!node) return { sql: null, residual: null };
  switch (node.kind) {
    case "condition": {
      const sql = compileLeaf(b, node);
      // 仅当该叶无法下推时才留内存；可下推叶 residual=null（不能重复进内存谓词）。
      return { sql, residual: sql ? null : node };
    }
    case "and": {
      const sqls: string[] = [];
      const residuals: FilterNode[] = [];
      for (const ch of node.children ?? []) {
        const r = compileNode(b, ch);
        if (r.sql) sqls.push(r.sql);
        if (r.residual) residuals.push(r.residual);
      }
      const sql = sqls.length ? sqls.map((s) => `(${s})`).join(" AND ") : null;
      const residual = combineResidual("and", residuals);
      return { sql, residual };
    }
    case "or": {
      const kids = node.children ?? [];
      // 全物理才下推；否则整棵 OR 回退（OR 片段自带括号）。
      const allSql: string[] = [];
      for (const ch of kids) {
        const r = compileNode(b, ch);
        if (!r.sql || r.residual) return { sql: null, residual: node };
        allSql.push(r.sql);
      }
      if (allSql.length === 0) return { sql: null, residual: null }; // 空 OR = true
      return { sql: `(${allSql.map((s) => `(${s})`).join(" OR ")})`, residual: null };
    }
    case "not": {
      if (!node.child) return { sql: null, residual: null };
      const r = compileNode(b, node.child);
      if (!r.sql || r.residual) return { sql: null, residual: node };
      return { sql: `(NOT (${r.sql}))`, residual: null };
    }
    default:
      return { sql: null, residual: node };
  }
}

function combineResidual(kind: "and" | "or", nodes: FilterNode[]): FilterNode | null {
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0]!;
  return { kind, children: nodes } as FilterNode;
}

// 标量（每记录每字段恰 1 行 rfi）且可索引的类型；multiSelect 多行、longText 正文、
// autoNumber、计算/关联类型都不满足（聚合 LEFT JOIN 会重复计数或语义不一）。
const SCALAR_INDEXED_TYPES = new Set<string>([
  ...SHORT_TEXT, ...NUM_LIKE, ...DATE_LIKE_TYPES, "checkbox", "singleSelect",
]);
const COUNT_FUNCS = new Set(["count", "countEmpty", "countFilled", "percentEmpty", "percentFilled"]);
const VALUE_NUM_FUNCS = new Set(["sum", "avg", "min", "max"]);

/**
 * 给定字段类型与请求的聚合函数，返回可安全下推到 sidecar 的子集。
 * 关键分歧防护：
 *  - 日期的 min/max【不能】下推——内存 aggregate.toNum 不做 Date.parse，对 ISO 串返回 null，
 *    而 sidecar valueNum 是毫秒，下推会算出非空值（静默偏差）；日期只下推计数类。
 *  - multiSelect/longText/autoNumber/计算/关联字段整体回退内存（多行或未索引/语义不一）。
 *  - 计数类（含 percent 推导）对标量字段安全；sum/avg/min/max 仅数值族（数值 5 型 + checkbox）。
 */
export function physicalAggFuncs(type: string, funcs: string[]): string[] {
  if (!SCALAR_INDEXED_TYPES.has(type)) return [];
  const valueNumOk = NUM_LIKE.has(type) || type === "checkbox";
  return funcs.filter((f) => COUNT_FUNCS.has(f) || (valueNumOk && VALUE_NUM_FUNCS.has(f)));
}

/** 排序可下推字段：仅 valueNum 族（数值/日期/checkbox）；多选/文本/autoNumber/计算字段回退。 */
function sortableValueNum(f: PlanField | undefined): boolean {
  if (!f) return false;
  return NUM_LIKE.has(f.type) || DATE_LIKE_TYPES.has(f.type) || f.type === "checkbox";
}

/**
 * 编译过滤 + 排序。fields 为该表全部活字段（含主字段标记）。
 * 排序仅当【过滤全物理】且【每个 sort 字段均可 valueNum 下推】时整体下推，否则内存排。
 */
export function compilePlan(
  tableId: string,
  fields: PlanField[],
  filters: FilterNode | null | undefined,
  sorts: SortSpec[] | null | undefined,
): CompiledPlan {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const b: Builder = { tableId, params: [], byId, bind(v) { this.params.push(v); return "?"; } };

  const fr = compileNode(b, filters ?? null);
  const fullyPhysical = fr.residual === null;

  let sortJoins: SortJoin[] | null = null;
  const ss = sorts ?? [];
  if (ss.length > 0 && fullyPhysical && ss.every((s) => sortableValueNum(byId.get(s.fieldId)))) {
    sortJoins = ss.map((s, i) => ({
      fieldId: s.fieldId,
      alias: `s${i}`,
      direction: s.direction === "desc" ? "desc" : "asc",
    }));
  }

  return {
    filterSql: fr.sql,
    filterParams: b.params,
    residual: fr.residual,
    sortJoins,
    filtersFullyPhysical: fullyPhysical,
  };
}
