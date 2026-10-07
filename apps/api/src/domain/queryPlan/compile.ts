// apps/api/src/domain/queryPlan/compile.ts
// M1/S6 queryPlan 纯编译器（无 DB 依赖）：把 ViewConfig.filters(FilterNode) + sorts[]
// 编译成三部分：
//   - physical：可下推到 sidecar（record_field_index）的参数化 WHERE 片段（别名 r 上，
//     不含前导 AND），值全部 ? 绑定；
//   - residual：不能下推、必须在候选集上跑内存 evalFilter 的 FilterNode 子树；
//   - sortPush：可下推的 valueNum 排序（valueText 因 SQLite BINARY 与 JS zh-CN numeric
//     排序不一致，M1 保守不下推）。
//
// 叶子（单条件 → EXISTS）在 compileLeaf.ts；本文件负责布尔树装配、同字段范围合并与排序。
//
// 正确性纪律（与 shared filter.ts evalFilter 逐行等价，宁可多回退也不撒谎）：
//   1) AND 可部分下推（物理子树下推、残余子树留内存）；OR/NOT 只要混入任一不可下推叶，
//      整棵子树回退内存——OR 无法安全部分下推。所有 OR 片段自带括号（不依赖 S2 anded）。
//   2) AND 内【同一标量字段】的多个正向 valueNum 谓词合并为单个 EXISTS：标量字段每记录恰
//      1 行 rfi，∃P1 ∧ ∃P2 ≡ ∃(P1∧P2)，消掉双相关 EXISTS 在密集索引上的 O(n²) 放大。
//      multiSelect 多行不满足该前提，绝不参与；neq/isNot 等 NOT 谓词也不参与。
//   3) 互补对用 NOT 折叠：neq=NOT eq、isNot=NOT is、isNoneOf=NOT isAnyOf、isNotEmpty=NOT isEmpty。
//   4) autoNumber 任何算符/排序都回退；数字/日期范围仅当字面量能转数值才下推。
//   5) 排序空值恒排后（ORDER BY (v IS NULL)），tie-break 固定 createdAt ASC,id ASC。

import type { FilterNode, FilterCondition, SortSpec } from "@gx/shared-types";
import { filterReferencesCurrentUser } from "@gx/shared-types";
import type { SqlBindValue } from "../../db/rawRead.js";
import {
  SHORT_TEXT,
  NUM_LIKE,
  DATE_LIKE_TYPES,
  compileLeaf,
  classifyNumLeaf,
  emitNumRangeExists,
  type Builder,
  type PlanField,
} from "./compileLeaf.js";
import { compileCountPlan, type CountPlan } from "./compileCount.js";

export type { PlanField } from "./compileLeaf.js";
export type { CountPlan } from "./compileCount.js";

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
  /**
   * 计数快速计划（rfi JOIN 驱动）：仅对纯合取/同字段 OR 的标量正向谓词产出；null 表示
   * 计数须回退 records 驱动相关 EXISTS（含 NOT/多行字段/跨字段 OR/残余等）。与 filterSql
   * 相互独立，只用于 countPhysical，不影响取页。
   */
  countPlan: CountPlan | null;
}

interface NodeResult {
  sql: string | null;
  residual: FilterNode | null;
}

/**
 * AND 子节点装配：先对「同字段 ≥2 个正向 valueNum 谓词」分组（标量字段前提已由
 * classifyNumLeaf 保证），合并成单 EXISTS；其余子节点逐个走 compileLeaf。
 * 返回物理 SQL 片段（未加外层括号）与残余节点。
 */
function compileAndChildren(b: Builder, kids: FilterNode[], denied: ReadonlySet<string> | null): { sqls: string[]; residuals: FilterNode[] } {
  // 仅对【条件叶】按 fieldId 分组；嵌套 AND/OR/NOT 不拆进合并（保持子树语义边界）。
  // 只收能 classify 成正向 valueNum 谓词的叶；标量前提已由 classifyNumLeaf 保证（NUM/DATE）。
  const fieldGroups = new Map<string, number[]>(); // fieldId → 子节点下标（保持原序）
  kids.forEach((node, idx) => {
    if (node.kind !== "condition") return;
    if (denied?.has(node.fieldId)) return; // M4/S6：掩码外字段不进物理下推
    if (!classifyNumLeaf(b, node as FilterCondition)) return;
    const list = fieldGroups.get(node.fieldId);
    if (list) list.push(idx);
    else fieldGroups.set(node.fieldId, [idx]);
  });

  const sqls: string[] = [];
  const residuals: FilterNode[] = [];
  const merged = new Set<number>(); // 已并入范围 EXISTS 的子节点下标
  kids.forEach((node, idx) => {
    if (node.kind === "condition") {
      // M4/S6：掩码外条件叶留内存（上层对脱敏 config 求值时该叶已移除，物理侧只做兜底屏蔽）。
      if (denied?.has(node.fieldId)) {
        residuals.push(node);
        return;
      }
      const group = fieldGroups.get(node.fieldId);
      if (group && group[0] === idx && group.length >= 2) {
        // 组首：把该字段全部正向谓词按原序并入【单个】EXISTS。
        const terms = group.map((i) => classifyNumLeaf(b, kids[i] as FilterCondition)!);
        sqls.push(emitNumRangeExists(b, node.fieldId, terms));
        group.forEach((i) => merged.add(i));
        return;
      }
      if (merged.has(idx)) return; // 已被合并的非首成员，不重复编译
    }
    const r = compileNode(b, node, denied);
    if (r.sql) sqls.push(r.sql);
    if (r.residual) residuals.push(r.residual);
  });
  return { sqls, residuals };
}

function compileNode(b: Builder, node: FilterNode | null | undefined, denied: ReadonlySet<string> | null = null): NodeResult {
  if (!node) return { sql: null, residual: null };
  switch (node.kind) {
    case "condition": {
      if (denied?.has(node.fieldId)) return { sql: null, residual: node }; // M4/S6：掩码外不物理下推
      const sql = compileLeaf(b, node as FilterCondition);
      // 仅当该叶无法下推时才留内存；可下推叶 residual=null（不能重复进内存谓词）。
      return { sql, residual: sql ? null : node };
    }
    case "and": {
      const kids = node.children ?? [];
      const { sqls, residuals } = compileAndChildren(b, kids, denied);
      const sql = sqls.length ? sqls.map((s) => `(${s})`).join(" AND ") : null;
      const residual = combineResidual("and", residuals);
      return { sql, residual };
    }
    case "or": {
      const children = node.children ?? [];
      // 全物理才下推；否则整棵 OR 回退（OR 片段自带括号）。
      // M4/S6：OR 内含任一掩码字段 -> 整棵 OR 不物理下推（隐藏分支真值未知）。
      if (denied && children.some((ch) => filterReferencesField(ch, denied))) {
        return { sql: null, residual: node };
      }
      const allSql: string[] = [];
      for (const ch of children) {
        const r = compileNode(b, ch, denied);
        if (!r.sql || r.residual) return { sql: null, residual: node };
        allSql.push(r.sql);
      }
      if (allSql.length === 0) return { sql: null, residual: null }; // 空 OR = true
      return { sql: `(${allSql.map((s) => `(${s})`).join(" OR ")})`, residual: null };
    }
    case "not": {
      if (!node.child) return { sql: null, residual: null };
      if (denied && filterReferencesField(node.child, denied)) return { sql: null, residual: node };
      const r = compileNode(b, node.child, denied);
      if (!r.sql || r.residual) return { sql: null, residual: node };
      return { sql: `(NOT (${r.sql}))`, residual: null };
    }
    case "formula":
      // 高级公式谓词永不下推 SQL：整节点留 residual，由 B 档内存精修求值（fail-closed）。
      return { sql: null, residual: node };
    default:
      return { sql: null, residual: node };
  }
}

/** 过滤子树是否引用了掩码外字段（任一条件叶命中即真）。 */
function filterReferencesField(node: FilterNode | null | undefined, denied: ReadonlySet<string>): boolean {
  if (!node) return false;
  if (node.kind === "condition") return denied.has(node.fieldId);
  // formula 节点不直接引用物理条件列；其内部字段引用经 buildFormulaSource 的 mask 钩子收口
  if (node.kind === "formula") return false;
  if (node.kind === "not") return filterReferencesField(node.child, denied);
  return (node.children ?? []).some((ch) => filterReferencesField(ch, denied));
}

function combineResidual(kind: "and" | "or", nodes: FilterNode[]): FilterNode | null {
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0]!;
  return { kind, children: nodes } as FilterNode;
}

// 标量（每记录每字段恰 1 行 rfi）且可索引的类型；multiSelect 多行、longText、autoNumber、
// 计算/关联类型不满足（聚合 LEFT JOIN 会重复计数或语义不一）。
const SCALAR_INDEXED_TYPES = new Set<string>([
  ...SHORT_TEXT, ...NUM_LIKE, ...DATE_LIKE_TYPES, "checkbox", "singleSelect",
]);
const COUNT_FUNCS = new Set(["count", "countEmpty", "countFilled", "percentEmpty", "percentFilled"]);
const VALUE_NUM_FUNCS = new Set(["sum", "avg", "min", "max"]);

/**
 * 给定字段类型与聚合函数，返回可安全下推到 sidecar 的子集。
 *  - 日期 min/max 不能下推（内存 aggregate.toNum 不 Date.parse，sidecar valueNum 是毫秒，会静默偏差）；
 *  - multiSelect/longText/autoNumber/计算/关联字段整体回退内存；
 *  - sum/avg/min/max 仅数值族（数值 5 型 + checkbox）。
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
 *
 * M4/S6：deniedFieldIds 为当前主体被 fieldMask 收窄掉的字段集（on 态传入，off/shadow 传
 * null/空集 -> 行为一字不变）。掩码外字段的条件叶【不进物理下推】、排序不下推，由上层对
 * 同一份脱敏 config 跑内存精修（compile 不自行删除 residual，以免与内存口径分叉；调用方用
 * sanitizeViewConfigForMask 得到两路径共用的脱敏 config，再把掩码集传此处做物理层兜底）。
 */
export function compilePlan(
  tableId: string,
  fields: PlanField[],
  filters: FilterNode | null | undefined,
  sorts: SortSpec[] | null | undefined,
  deniedFieldIds?: ReadonlySet<string> | null,
  currentUserId?: string | null,
): CompiledPlan {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const denied = deniedFieldIds ?? null;
  const b: Builder = {
    tableId,
    params: [],
    byId,
    currentUserId: currentUserId ?? null,
    bind(v) { this.params.push(v); return "?"; },
  };

  // fail-closed 树顶层短路：树引用 currentUser 而当前无登录用户（未登录 / 分享外链 / 空
  // userId）时，整棵过滤恒假。不能只让叶子回退 —— 叶子可能被 NOT 包裹，!(false)=true
  // 会放开全表（与内存 evalFilter 的顶层短路同源，见 filterReferencesCurrentUser）。
  // 产出 filterSql=(1=0)、无残余：物理候选/计数/取页在任何档位都为空集。
  if (filterReferencesCurrentUser(filters ?? null) && !(currentUserId ?? null)) {
    return {
      filterSql: "(1=0)",
      filterParams: [],
      residual: null,
      sortJoins: null,
      filtersFullyPhysical: true,
      countPlan: null,
    };
  }

  // 计数快速计划独立累积绑定（不写 b.params），只在过滤树可安全改写为 rfi JOIN 时产出。
  const countPlan = compileCountPlan(b, filters ?? null, denied);

  const fr = compileNode(b, filters ?? null, denied);
  const fullyPhysical = fr.residual === null;

  let sortJoins: SortJoin[] | null = null;
  const ss = sorts ?? [];
  if (
    ss.length > 0 && fullyPhysical &&
    ss.every((s) => !denied?.has(s.fieldId) && sortableValueNum(byId.get(s.fieldId)))
  ) {
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
    countPlan,
  };
}
