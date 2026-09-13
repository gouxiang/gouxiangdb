// apps/api/src/domain/queryPlan/compileLeaf.ts
// M1/S6 物理过滤叶子编译器（从 compile.ts 拆出，单一职责：单个 FilterCondition → sidecar EXISTS）。
// compile.ts 负责布尔树/合并/排序，本文件只回答「这一个条件能否下推、下推成哪个相关 EXISTS」。
//
// 正确性纪律（与 shared filter.ts evalFilter 逐行等价）：
//   - autoNumber 任何算符都回退（sidecar 文本 vs hydrate 计算编号语义不一）；
//   - 数字/日期范围算符仅当字面量能转数值才下推，否则回退（evalFilter 退回文本比较）；
//   - neq/isNot/isNoneOf 用 NOT 折叠；checked/unchecked 非互补，各自生成；
//   - LIKE 仅短文本四类型，转义 \ % _ 并 ESCAPE '\\'。
//
// 同字段范围合并见 classifyNumLeaf / emitNumRangeExists：标量字段（每记录每字段恰 1 行 rfi）
// 上，∃row(P1) ∧ ∃row(P2) ≡ ∃row(P1∧P2)，故同字段多个正向 valueNum 谓词可安全并入单 EXISTS。
// multiSelect 多行【不满足】该前提，绝不参与合并。

import type { FilterCondition } from "@gx/shared-types";
import type { SqlBindValue } from "../../db/rawRead.js";

/** 编译所需的最小字段描述（FieldMeta 的子集）。 */
export interface PlanField {
  id: string;
  type: string;
  isPrimary?: boolean;
}

export const SHORT_TEXT = new Set(["singleLineText", "email", "url", "phone"]);
export const NUM_LIKE = new Set(["number", "currency", "percent", "duration", "rating"]);
export const DATE_LIKE_TYPES = new Set(["date", "datetime"]);
const DATE_LIKE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export interface Builder {
  tableId: string;
  params: SqlBindValue[];
  byId: Map<string, PlanField>;
  bind(v: SqlBindValue): string;
}

/** 与 shared filter.ts toNumber 同构：数字直转，日期形态按毫秒，否则 null。 */
export function literalNum(lit: string): number | null {
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

/** 与 policy.isIndexedField 同口径的最小判定（autoNumber 入索引但不参与下推）。 */
export function isIndexedPlanField(f: PlanField): boolean {
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

/** 生成一个相关 EXISTS（别名 x），按 tableId → fieldId → inner 值顺序绑定。 */
function existsSql(b: Builder, fieldId: string, inner: string, extra: SqlBindValue[] = []): string {
  b.bind(b.tableId);
  b.bind(fieldId);
  for (const v of extra) b.bind(v);
  return (
    `EXISTS(SELECT 1 FROM "record_field_index" x ` +
    `WHERE x."recordId"=r."id" AND x."tableId"=? AND x."fieldId"=? AND ${inner})`
  );
}

/** 单条件 → sidecar 相关 EXISTS 内层谓词（别名 x）；null = 不可下推。 */
export function compileLeaf(b: Builder, c: FilterCondition): string | null {
  if (c.valueType === "field") return null; // 跨列比较恒回退
  const f = b.byId.get(c.fieldId);
  if (!f) return null;
  const t = f.type;
  const op = c.op;

  // autoNumber 恒回退（含 isEmpty）：sidecar 存原始空（hydrate 却现算编号），任何谓词都不一致。
  if (t === "autoNumber") return null;

  const exists = (inner: string, extra: SqlBindValue[] = []): string =>
    existsSql(b, c.fieldId, inner, extra);
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
    // neq 用 NOT 折叠（null 行不命中 =/NOT EXISTS 为真，与数值字面量下 evalFilter 一致）。
    return op === "neq" ? notExists(`x."valueNum" = ?`, [n]) : exists(`x."valueNum" ${sym} ?`, [n]);
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
    // 短文本 isAnyOf/isNoneOf 内存大小写不敏感而 SQL IN BINARY 敏感 → 回退。
    // LIKE 仅短文本四类型（主字段若为 longText，contains 按规格回退）。
    if (SHORT_TEXT.has(t) && (op === "contains" || op === "startsWith" || op === "endsWith")) {
      // 空 pattern 在内存里恒真（含空值行），无法用 isNull=0 的 LIKE 表达 → 回退内存。
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

/** 可参与「同字段 valueNum 范围合并」的正向谓词；不满足（NOT/非数值/多行类型）返回 null。 */
export interface NumTerm {
  sym: string;
  n: number;
}

export function classifyNumLeaf(b: Builder, c: FilterCondition): NumTerm | null {
  if (c.valueType === "field") return null;
  const f = b.byId.get(c.fieldId);
  if (!f) return null;
  const numLike = NUM_LIKE.has(f.type);
  const dateRange = DATE_LIKE_TYPES.has(f.type);
  if (!numLike && !dateRange) return null;
  // 仅正向比较；neq（NOT 折叠）、日期 is/isNot（valueText）不参与。
  const sym = numLike
    ? ({ eq: "=", gt: ">", lt: "<", gte: ">=", lte: "<=" } as Record<string, string>)[c.op]
    : ({ gt: ">", lt: "<", gte: ">=", lte: "<=" } as Record<string, string>)[c.op];
  if (!sym) return null;
  const n = literalNum(c.value);
  return n === null ? null : { sym, n };
}

/**
 * 把同字段多个正向 valueNum 谓词并入【单个】相关 EXISTS（绑定一次 tableId/fieldId）。
 * 前提：该字段标量（每记录恰 1 行 rfi），调用方须已用 classifyNumLeaf 过滤为 NUM/DATE 类型。
 * terms 按 FilterNode children 原序拼接，值绑定顺序与占位符同序。
 */
export function emitNumRangeExists(b: Builder, fieldId: string, terms: NumTerm[]): string {
  const inner = terms.map((t) => `x."valueNum" ${t.sym} ?`).join(" AND ");
  return existsSql(b, fieldId, `(${inner})`, terms.map((t) => t.n));
}
