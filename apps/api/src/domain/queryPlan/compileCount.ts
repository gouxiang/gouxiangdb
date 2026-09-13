// apps/api/src/domain/queryPlan/compileCount.ts
// M1/S10 计数计划编译器：把可安全改写为「record_field_index 驱动半连接」的过滤树编译成
// 一组 rfi JOIN，使 filteredTotal 的 COUNT 从 records 全表逐行相关 EXISTS（5000 行约 1.6s）
// 变为 rfi 索引 range seek（实测 1.5ms，约 1000 倍）。
//
// 为什么能等价：参与本计划的字段【必为标量字段】（每记录每字段恰 1 行 rfi，见 policy 与
// sidecar DDL），故 INNER JOIN rfi 不会让一条 record 被计数两次；谓词全部是【正向】谓词，
// ∃命中 rfi 行 与 该 rfi 行 JOIN 命中一一对应。下列情形一律放弃（返回 null），回退 compile.ts
// 的 records 驱动相关 EXISTS，宁可慢也不改变计数：
//   - NOT 折叠谓词（neq/isNot/isNoneOf）与 isEmpty：空值/补集语义无法用 INNER JOIN 表达；
//   - multiSelect 多行字段（IN 后 JOIN 会重复计数）；
//   - autoNumber/计算/关联等不入标量索引的字段；
//   - 跨字段 OR（无法用单表 rfi JOIN 表达）；OR 仅当全部叶子同字段时并入该字段的一个 JOIN；
//   - 任何 valueType=field 跨列比较、字面量转不出数值的数值/日期范围。
//
// 与 compile.ts 的过滤计划相互独立：compile.filterSql 仍驱动取页（逐值正确性由 parity 对拍
// 锁定），本计划只用于 countPhysical 的计数快速路径；二者必须在同一过滤树上各自可回退。

import type { FilterNode, FilterCondition } from "@gx/shared-types";
import type { SqlBindValue } from "../../db/rawRead.js";
import {
  SHORT_TEXT,
  NUM_LIKE,
  DATE_LIKE_TYPES,
  literalNum,
  type Builder,
  type PlanField,
} from "./compileLeaf.js";

export interface CountPlan {
  /** FROM records r 之后的 JOIN 片段（别名 c0/c1…，每个不同 fieldId 一个）。 */
  joins: string;
  /** 与 joins 中占位符严格同序的绑定值（每 JOIN：tableId, fieldId, 再各谓词值）。 */
  joinParams: SqlBindValue[];
}

interface Term {
  /** 单个叶子在 rfi 列上的正向谓词（别名由装配时给的 alias 替换 C 占位）。 */
  expr: string;
  params: SqlBindValue[];
  fieldId: string;
}

/**
 * 把一个条件叶编译成 rfi 正向谓词；不可安全改写返回 null。
 * expr 中用 "c" 占位 rfi 别名，装配 JOIN 时替换为实际 cN。
 */
function countTerm(byId: Map<string, PlanField>, c: FilterCondition): Term | null {
  if (c.valueType === "field") return null;
  const f = byId.get(c.fieldId);
  if (!f) return null;
  const t = f.type;
  const op = c.op;
  const C = "c";

  if (t === "autoNumber") return null;

  // isEmpty → isNull=1（标量 1 行，空字段也有 isNull=1 行，INNER JOIN 可命中），可安全改写。
  if (op === "isEmpty") {
    if (!scalarIndexed(f)) return null;
    return { fieldId: c.fieldId, expr: `${C}."isNull"=1`, params: [] };
  }
  if (op === "isNotEmpty") {
    if (!scalarIndexed(f)) return null;
    return { fieldId: c.fieldId, expr: `${C}."isNull"=0`, params: [] };
  }

  // 数值族正向比较（neq 不参与）。
  if (NUM_LIKE.has(t)) {
    const sym: string | undefined = ({ eq: "=", gt: ">", lt: "<", gte: ">=", lte: "<=" } as Record<string, string>)[op];
    if (!sym) return null;
    const n = literalNum(c.value);
    if (n === null) return null;
    return { fieldId: c.fieldId, expr: `${C}."valueNum" ${sym} ?`, params: [n] };
  }

  // 日期：is 走 valueText（标量），gt..lte 走 valueNum 毫秒；isNot 不参与。
  if (DATE_LIKE_TYPES.has(t)) {
    if (op === "is") return { fieldId: c.fieldId, expr: `${C}."valueText" = ?`, params: [c.value] };
    const sym: string | undefined = ({ gt: ">", lt: "<", gte: ">=", lte: "<=" } as Record<string, string>)[op];
    if (!sym) return null;
    const n = literalNum(c.value);
    if (n === null) return null;
    return { fieldId: c.fieldId, expr: `${C}."valueNum" ${sym} ?`, params: [n] };
  }

  // checkbox（标量 0/1 单行；unchecked 的 OR+isNull 在单 rfi 行上安全）。
  if (t === "checkbox") {
    if (op === "checked") return { fieldId: c.fieldId, expr: `${C}."valueNum"=1`, params: [] };
    if (op === "unchecked") return { fieldId: c.fieldId, expr: `(${C}."isNull"=1 OR ${C}."valueNum"=0)`, params: [] };
    return null;
  }

  // 单选（标量单行）：is / isAnyOf-IN 安全；isNot/isNoneOf 不参与。
  if (t === "singleSelect") {
    if (op === "is") return { fieldId: c.fieldId, expr: `${C}."isNull"=0 AND ${C}."valueText" = ?`, params: [c.value] };
    if (op === "isAnyOf") {
      const items = c.value.split(",").map((s) => s.trim()).filter(Boolean);
      if (items.length === 0) return null;
      return {
        fieldId: c.fieldId,
        expr: `${C}."isNull"=0 AND ${C}."valueText" IN (${items.map(() => "?").join(",")})`,
        params: items,
      };
    }
    return null;
  }

  // multiSelect 多行：放弃（JOIN 重复计数）。
  if (t === "multiSelect") return null;

  // 短文本四类型 + 标量主字段：is（valueText 等值）与 LIKE 安全（单行）。
  const textEq = SHORT_TEXT.has(t) || (f.isPrimary === true && scalarIndexed(f));
  if (textEq) {
    if (op === "is") return { fieldId: c.fieldId, expr: `${C}."isNull"=0 AND ${C}."valueText" = ?`, params: [c.value] };
    if (SHORT_TEXT.has(t) && (op === "contains" || op === "startsWith" || op === "endsWith")) {
      if (c.value === "") return null;
      const pat =
        op === "contains" ? `%${escLike(c.value)}%`
        : op === "startsWith" ? `${escLike(c.value)}%`
        : `%${escLike(c.value)}`;
      return { fieldId: c.fieldId, expr: `${C}."isNull"=0 AND ${C}."valueText" LIKE ? ESCAPE '\\'`, params: [pat] };
    }
  }

  return null;
}

function scalarIndexed(f: PlanField): boolean {
  return (
    SHORT_TEXT.has(f.type) ||
    NUM_LIKE.has(f.type) ||
    DATE_LIKE_TYPES.has(f.type) ||
    f.type === "checkbox" ||
    f.type === "singleSelect"
  );
}

function escLike(v: string): string {
  return v.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** 把 AND 扁平化成条件叶（嵌套 AND 展开）；遇非 AND 结构返回 null。 */
function flattenAnd(node: FilterNode): FilterCondition[] | null {
  if (node.kind === "condition") return [node as FilterCondition];
  if (node.kind !== "and" || !node.children) return null;
  const out: FilterCondition[] = [];
  for (const ch of node.children) {
    const f = flattenAnd(ch);
    if (!f) return null;
    out.push(...f);
  }
  return out;
}

/**
 * 编译计数计划。
 * @param b 仅用其 tableId/byId（参数独立累积到返回值，不写 b.params）。
 * @returns 可 rfi-JIN 驱动则返回 CountPlan；过滤为空返回 null（调用方走无过滤 count(*)），
 *          含任何不可安全改写结构也返回 null（回退相关 EXISTS，语义不变）。
 */
export function compileCountPlan(b: Builder, filters: FilterNode | null | undefined): CountPlan | null {
  if (!filters) return null;

  // 顶层 OR：仅当所有叶子【同一字段】且都可改写时，并入该字段的一个 JOIN（inner 用 OR 连）。
  if (filters.kind === "or" && filters.children) {
    const leaves = filters.children;
    if (leaves.length === 0) return null;
    const terms: Term[] = [];
    for (const ch of leaves) {
      if (ch.kind !== "condition") return null;
      const tm = countTerm(b.byId, ch as FilterCondition);
      if (!tm) return null;
      terms.push(tm);
    }
    const fieldId = terms[0]!.fieldId;
    if (!terms.every((t) => t.fieldId === fieldId)) return null; // 跨字段 OR 放弃
    return assemble(b, new Map([[fieldId, { comb: "OR", terms }]]));
  }

  // 其余按纯 AND 处理。
  const leaves = flattenAnd(filters);
  if (!leaves) return null;
  const groups = new Map<string, { comb: "AND" | "OR"; terms: Term[] }>();
  for (const leaf of leaves) {
    const tm = countTerm(b.byId, leaf);
    if (!tm) return null;
    let g = groups.get(tm.fieldId);
    if (!g) {
      g = { comb: "AND", terms: [] };
      groups.set(tm.fieldId, g);
    }
    g.terms.push(tm);
  }
  return assemble(b, groups);
}

/** 按字段分组装配 INNER JOIN（别名 c0..）；同字段多谓词按 AND（或同字段 OR 的 OR）并入。 */
function assemble(
  b: Builder,
  groups: Map<string, { comb: "AND" | "OR"; terms: Term[] }>,
): CountPlan | null {
  if (groups.size === 0) return null;
  const joins: string[] = [];
  const joinParams: SqlBindValue[] = [];
  let aliasIdx = 0;
  for (const [fieldId, g] of groups) {
    const alias = `c${aliasIdx++}`;
    const inner = g.terms
      .map((t) => t.expr.replace(/\bc\./g, `${alias}.`))
      .join(g.comb === "OR" ? " OR " : " AND ");
    joins.push(
      `JOIN "record_field_index" ${alias} ON ${alias}."recordId"=r."id" ` +
      `AND ${alias}."tableId"=? AND ${alias}."fieldId"=? AND (${inner})`,
    );
    // 占位符出现顺序：JOIN ON 内先 tableId、fieldId，再各谓词值。
    joinParams.push(b.tableId, fieldId);
    for (const t of g.terms) joinParams.push(...t.params);
  }
  return { joins: joins.join(" "), joinParams };
}
