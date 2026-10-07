// apps/api/src/domain/queryPlan/formulaEval.ts
// 高级筛选（kind:"formula"）的内存求值器。
//
// formula 节点永不下推 SQL：B 档物理粗筛得到候选超集后，在 hydrate 完毕的记录上
// 逐条对表达式求值，严格要求布尔结果。复用 hydrate.buildFormulaSource 的取值范式
// （{字段} / {关联.子字段} 点引用、跨表权限钩子收口），与公式字段/默认值公式同源。
//
// 缓存与 N+1 控制：
//   - 一个 evaluator 的 HydrationContext 结构跨记录复用（与 hydrateRecords 的单 ctx
//     跨记录模式一致）：fieldCache 缓存对端表字段、mergedCache 缓存点引用子记录的
//     完整 hydration 结果，同一子记录只算一次；
//   - 预填当前表每条记录进 mergedCache，点引用恰好落在本表时直接命中，不回查；
//   - parseCached（formula.ts 内，上限 500）保证同一表达式只 parse 一次。
//
// fail-closed：表达式非法 / 求值抛错 / 结果非 {t:"bool"} 一律判 false（不放行）。

import type { FilterNode } from "@gx/shared-types";
import type { FieldMeta, FieldValue, HydratedRecord } from "../types.js";
import type { HydrateDeps } from "../hydrate.js";
import { buildFormulaSource } from "../hydrate.js";
import { safeEvaluateFormula } from "../formula.js";

/**
 * 与 hydrate.HydrationContext 结构同形（该接口未导出）。
 * buildFormulaSource 只经 ctx 访问这些字段；其内部调用的 getMergedCached /
 * computeFormulas / buildFirstPassMerged 均为 hydrate 模块内函数，不依赖 ctx 上的方法。
 */
interface FormulaEvalContext {
  deps: HydrateDeps;
  fieldCache: Map<string, FieldMeta[]>;
  shallowCache: Map<string, Record<string, FieldValue>>;
  mergedCache: Map<string, Record<string, FieldValue>>;
  merging: Set<string>;
  stack: Set<string>;
}

/** 收集过滤树内全部 formula 表达式（去重、保首次出现顺序；空白表达式也收，由求值侧短路）。 */
export function collectFormulaExpressions(
  node: FilterNode | null | undefined,
  out: string[] = [],
  seen: Set<string> = new Set(),
): string[] {
  if (!node) return out;
  if (node.kind === "formula") {
    if (!seen.has(node.expression)) {
      seen.add(node.expression);
      out.push(node.expression);
    }
    return out;
  }
  if (node.kind === "not") collectFormulaExpressions(node.child, out, seen);
  else if (node.kind === "and" || node.kind === "or") {
    for (const ch of node.children) collectFormulaExpressions(ch, out, seen);
  }
  // condition 叶不含 formula
  return out;
}

export function filterHasFormulaNode(node: FilterNode | null | undefined): boolean {
  return collectFormulaExpressions(node).length > 0;
}

/**
 * 为一批记录构造 formula 谓词回调：recordId -> (expression => boolean)。
 * 过滤树不含 formula 节点时返回 null（调用方据此走原同步路径，evalFormula 保持 undefined）。
 * 同一 evaluator 跨记录复用，mergedCache 让被点引用的子记录在批内只 hydration 一次。
 */
export async function buildFormulaCallbacks(
  tableId: string,
  fields: FieldMeta[],
  filters: FilterNode | null | undefined,
  records: readonly HydratedRecord[],
  deps: HydrateDeps,
): Promise<Map<string, (expression: string) => boolean> | null> {
  const expressions = collectFormulaExpressions(filters);
  if (expressions.length === 0) return null;
  const evaluator = new FormulaFilterEvaluator(tableId, fields, deps);
  const callbacks = new Map<string, (expression: string) => boolean>();
  for (const record of records) {
    const results = await evaluator.evaluateRecord(record, expressions);
    callbacks.set(record.id, (expression: string) => results.get(expression) ?? false);
  }
  return callbacks;
}

/** 高级筛选内存求值器：跨记录共享缓存，对一批 hydrate 完毕的记录求布尔谓词。 */
export class FormulaFilterEvaluator {
  private readonly ctx: FormulaEvalContext;

  constructor(
    private readonly tableId: string,
    private readonly fields: FieldMeta[],
    deps: HydrateDeps,
  ) {
    this.ctx = {
      deps,
      fieldCache: new Map([[tableId, fields]]),
      shallowCache: new Map(),
      mergedCache: new Map(),
      merging: new Set(),
      stack: new Set(),
    };
  }

  /**
   * 对一条记录求全部表达式的布尔结果。
   * @returns expression -> 是否命中（严格布尔真；异常/非布尔/空表达式按 fail-closed 语义：
   *          空表达式 map 中为 true，其余失败为 false，与 evalFilter 的 case:"formula" 对齐）
   */
  async evaluateRecord(
    record: HydratedRecord,
    expressions: readonly string[],
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    // 当前记录预填 mergedCache：点引用子记录恰为本表记录时直接命中完整 hydration。
    // key 用记录自身 tableId（hydrate 内部 getMergedCached 同键），保证缓存可命中。
    this.ctx.mergedCache.set(`${record.tableId}:${record.id}`, record.fields);
    for (const expression of expressions) {
      if (typeof expression !== "string" || expression.trim() === "") {
        results.set(expression, true); // 无筛选
        continue;
      }
      try {
        const source = await buildFormulaSource(
          expression,
          null,
          this.fields,
          record.fields,
          this.ctx,
        );
        const { value, error } = safeEvaluateFormula(expression, source);
        // 严格布尔：仅 {t:"bool"} 取值；数值/字符串/list/null 与任何 error 一律 false。
        results.set(expression, !error && value.t === "bool" ? value.v === true : false);
      } catch {
        results.set(expression, false);
      }
    }
    return results;
  }
}
