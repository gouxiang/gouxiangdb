// apps/api/src/domain/recordService.ts
// 记录查询编排：hydrate → filter → search → sort → group → aggregate → paginate
//
// 这是「列表渲染」的唯一真源：Grid / Gallery / Kanban / Calendar 全部走这里，
// 保证同一份视图配置在任何视图类型下得到完全一致的数据集（v1 各视图各自实现的隐患在此消除）。

import { prisma } from "../db.js";
import type { HydratedRecord, FieldMeta } from "./types.js";
import { toFieldMeta, toRawRecord, prismaDeps } from "./prismaDeps.js";
import { hydrateRecords } from "./hydrate.js";
import { evalFilter, matchesSearch } from "./filter.js";
import { sortRows } from "./sort.js";
import { assembleGroups, assembleAggregations } from "./queryPlan/assemble.js";
import { isGridSkipType } from "@gx/shared-types";
import type { FilterNode, SortSpec, ViewConfig } from "@gx/shared-types";

export interface QueryOptions {
  tableId: string;
  fields: FieldMeta[];
  config: ViewConfig;
  search?: string;
  limit?: number;
  offset?: number;
  /** 跳过分页（导出全量用） */
  noPaging?: boolean;
}

export interface QueryResult {
  records: HydratedRecord[];
  total: number;
  filteredTotal: number;
  groups: { key: string; label: string; color: string | null; recordIds: string[]; aggregations: Record<string, number | null> }[] | null;
  aggregations: Record<string, number | null> | null;
}

/** 取视图实际可见字段（按 fieldOrder 重排，剔除 hidden；tabs/subtable 仅在 detail 显示，不进列表） */
export function visibleFields(fields: FieldMeta[], config: ViewConfig): FieldMeta[] {
  const order = config.fieldOrder ?? [];
  let base = [...fields];
  if (order.length > 0) {
    const rank = new Map(order.map((id, i) => [id, i]));
    base.sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999));
  }
  if (config.hiddenFieldIds && config.hiddenFieldIds.length > 0) {
    const hidden = new Set(config.hiddenFieldIds);
    base = base.filter((f) => !hidden.has(f.id));
  }
  // 容器型字段（tabs/subtable）只用于详情分组/子表，不在任何列表视图渲染
  base = base.filter((f) => !isGridSkipType(f.type));
  return base;
}

/**
 * 视图后处理（M1/S5 抽出为纯函数）：对已 hydrate 的记录依次套用 视图过滤 → 搜索 → 排序。
 * 列表 queryRecords 与导出（keyset 分批 hydrate 后）共用，保证两条路径筛选/排序口径零漂移。
 * 不含分页/分组/聚合（导出不需要；列表在调用方继续处理）。
 */
export function applyViewQuery(
  hydrated: HydratedRecord[],
  fields: FieldMeta[],
  config: ViewConfig,
  search: string,
): HydratedRecord[] {
  let out = hydrated;

  // 过滤
  if (config.filters) {
    out = out.filter((r) => evalFilter(config.filters as FilterNode | null, (fid) => r.fields[fid]));
  }

  // 搜索（全部可见字段文本化后 contains）
  const q = search.trim();
  if (q !== "") {
    const searchable = visibleFields(fields, config).filter(
      (f) => !["attachment", "links", "lookup", "rollup", "count", "formula"].includes(f.type),
    );
    out = out.filter((r) => matchesSearch(searchable.map((f) => r.fields[f.id]), q));
  }

  // 排序
  const fieldTypes: Record<string, string> = {};
  for (const f of fields) fieldTypes[f.id] = f.type;
  if (config.sorts && config.sorts.length > 0) {
    out = sortRows(
      out.map((r) => ({ id: r.id, rec: r, get: (fid: string) => r.fields[fid] })),
      config.sorts as SortSpec[],
      fieldTypes,
    ).map((x) => x.rec);
  }
  return out;
}

/**
 * 列表查询入口（S6 起按 GX_M1_SIDECAR_READ 分派）：
 *   off（默认）→ queryRecordsLegacy：全表 hydrate + 内存 filter/search/sort（S5 行为，完全回退）；
 *   shadow      → 旧结果照返回，额外跑 queryPlan 计划器并只记差异（不影响响应）；
 *   on          → 走 sidecar queryPlan 计划器（physical 下推 + 当页 hydrate）。
 * 写侧 GX_M1_SIDECAR=off 或派生表不可用时强制回退旧路径（计划器异常也安全回退）。
 */
export async function queryRecords(opts: QueryOptions): Promise<QueryResult> {
  const { resolveSidecarReadMode, sidecarReadUsable } = await import("./queryPlan/flags.js");
  const mode = resolveSidecarReadMode();
  if (mode === "off" || !sidecarReadUsable()) return await queryRecordsLegacy(opts);

  if (mode === "shadow") {
    const legacyP = queryRecordsLegacy(opts);
    // shadow 对拍失败绝不影响旧结果：计划器报错只记日志。
    const [legacy, planned] = await Promise.all([
      legacyP,
      runPlannerSafe(opts).catch((e) => {
        console.warn("[queryPlan][shadow] 计划器异常（忽略，返回旧结果）:", (e as Error).message);
        return null;
      }),
    ]);
    if (planned) logShadowDiff(opts, legacy, planned);
    return legacy;
  }

  // on：计划器异常时安全回退旧路径（读可用性不因 sidecar 问题受损）。
  try {
    return await runPlannerOnce(opts);
  } catch (e) {
    console.warn("[queryPlan][on] 计划器失败，回退旧路径:", (e as Error).message);
    return await queryRecordsLegacy(opts);
  }
}

async function runPlannerOnce(opts: QueryOptions) {
  const [{ getSidecarQuerier }, { runQueryPlan }] = await Promise.all([
    import("./queryPlan/connection.js"),
    import("./queryPlan/planner.js"),
  ]);
  const search = (opts.search ?? opts.config.search ?? "").trim();
  const r = await runQueryPlan(getSidecarQuerier(), {
    tableId: opts.tableId,
    fields: opts.fields,
    config: opts.config,
    search,
    limit: opts.limit ?? 200,
    offset: opts.offset ?? 0,
    noPaging: opts.noPaging ?? false,
  });
  return {
    records: r.records,
    total: r.total,
    filteredTotal: r.filteredTotal,
    groups: r.groups,
    aggregations: r.aggregations,
  } satisfies QueryResult;
}

async function runPlannerSafe(opts: QueryOptions) {
  return await runPlannerOnce(opts);
}

/** shadow 对拍：recordId 序列 / total / filteredTotal / 表尾聚合差异，只记日志（脱敏，无字段值）。 */
function logShadowDiff(opts: QueryOptions, legacy: QueryResult, planned: QueryResult): void {
  const diffs: string[] = [];
  if (legacy.total !== planned.total) diffs.push(`total ${legacy.total}!=${planned.total}`);
  if (legacy.filteredTotal !== planned.filteredTotal) {
    diffs.push(`filteredTotal ${legacy.filteredTotal}!=${planned.filteredTotal}`);
  }
  const lids = legacy.records.map((r) => r.id);
  const pids = planned.records.map((r) => r.id);
  if (lids.length !== pids.length || lids.some((id, i) => id !== pids[i])) {
    const first = lids.findIndex((id, i) => id !== pids[i]);
    diffs.push(`recordId 序列分歧 firstAt=${first} legacyN=${lids.length} plannedN=${pids.length}`);
  }
  const la = legacy.aggregations ?? {};
  const pa = planned.aggregations ?? {};
  for (const fid of new Set([...Object.keys(la), ...Object.keys(pa)])) {
    if (Math.abs((la[fid] ?? NaN) - (pa[fid] ?? NaN)) > 1e-6) {
      diffs.push(`agg[${fid}] ${la[fid]}!=${pa[fid]}`);
    }
  }
  if (diffs.length > 0) {
    console.warn(`[queryPlan][shadow] 差异 table=${opts.tableId}: ${diffs.join("; ")}`);
  }
}

/**
 * S5 旧列表路径（GX_M1_SIDECAR_READ=off 的完整行为，shadow/on 异常回退亦用此）：
 * 全表 hydrate → 内存 filter/search/sort → 分组/聚合 → 分页。行为一个值不变。
 */
export async function queryRecordsLegacy(opts: QueryOptions): Promise<QueryResult> {
  const { tableId, fields, config } = opts;
  const search = (opts.search ?? config.search ?? "").trim();

  // 1. 拉原始记录
  const rows = await prisma.record.findMany({
    where: { tableId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const total = rows.length;

  // 2. hydrate（计算字段在此现算）
  let hydrated = await hydrateRecords(
    rows.map(toRawRecord),
    fields,
    prismaDeps,
  );

  // 3-5. 视图过滤 / 搜索 / 排序（纯内存，导出与列表共用同一后处理，口径零漂移）
  hydrated = applyViewQuery(hydrated, fields, config, search);

  const filteredTotal = hydrated.length;

  // 6. 分组 + 表尾聚合（组装纯函数由旧路径与 S6 queryPlan 计划器共用，两路径同源零分歧）。
  const groups = assembleGroups(hydrated, fields, config);
  const aggregations = assembleAggregations(hydrated, config.aggregations ?? {});

  // 7. 分页
  if (!opts.noPaging) {
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 200;
    hydrated = hydrated.slice(offset, offset + limit);
  }

  return { records: hydrated, total, filteredTotal, groups, aggregations };
}

/** 读一张表的所有未删字段 */
export async function loadTableFields(tableId: string): Promise<FieldMeta[]> {
  const rows = await prisma.field.findMany({
    where: { tableId, deletedAt: null },
    orderBy: { order: "asc" },
  });
  return rows.map(toFieldMeta);
}

/**
 * M1/S5 单行 hydration：只取目标 RawRecord + 对该行跑完整两阶段 hydrate，
 * 替代 POST/PATCH/详情里「queryRecords(noPaging) 拉全表再 .find」的全表回查。
 * 取值算法与列表完全一致（同一个 hydrateRecords + prismaDeps），故返回的那一条与
 * 旧全表回查 .find 结果逐值 deep-equal（见 S5 对拍测试）。记录软删/不存在/表不符返回 null。
 */
export async function hydrateRecordById(
  tableId: string,
  recordId: string,
): Promise<HydratedRecord | null> {
  const row = await prisma.record.findUnique({ where: { id: recordId } });
  if (!row || row.deletedAt || row.tableId !== tableId) return null;
  const fields = await loadTableFields(tableId);
  const [hydrated] = await hydrateRecords([toRawRecord(row)], fields, prismaDeps);
  return hydrated ?? null;
}

/** 解析视图配置（View.config 是 JSON 字符串） */
export function parseViewConfig(raw: string | null): ViewConfig {
  if (!raw) {
    return {
      hiddenFieldIds: [],
      fieldOrder: [],
      rowHeight: "medium",
      filters: null,
      sorts: [],
      search: "",
      groupByFieldId: null,
      collapsedGroupKeys: [],
      aggregations: {},
      rowColor: { mode: "none", conditions: [] },
      coverFieldId: null,
      cardFieldIds: [],
      kanbanFieldId: null,
      dateFieldId: null,
      formFields: [],
      formTitle: "",
      formDescription: "",
      detailFieldIds: [],
      detailLayout: null,
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ViewConfig>;
    return {
      hiddenFieldIds: parsed.hiddenFieldIds ?? [],
      fieldOrder: parsed.fieldOrder ?? [],
      rowHeight: parsed.rowHeight ?? "medium",
      filters: parsed.filters ?? null,
      sorts: parsed.sorts ?? [],
      search: parsed.search ?? "",
      groupByFieldId: parsed.groupByFieldId ?? null,
      collapsedGroupKeys: parsed.collapsedGroupKeys ?? [],
      aggregations: parsed.aggregations ?? {},
      rowColor: parsed.rowColor ?? { mode: "none", conditions: [] },
      coverFieldId: parsed.coverFieldId ?? null,
      cardFieldIds: parsed.cardFieldIds ?? [],
      kanbanFieldId: parsed.kanbanFieldId ?? null,
      dateFieldId: parsed.dateFieldId ?? null,
      formFields: parsed.formFields ?? [],
      formTitle: parsed.formTitle ?? "",
      formDescription: parsed.formDescription ?? "",
      detailFieldIds: parsed.detailFieldIds ?? [],
      detailLayout: parsed.detailLayout ?? null,
    };
  } catch {
    return {
      hiddenFieldIds: [],
      fieldOrder: [],
      rowHeight: "medium",
      filters: null,
      sorts: [],
      search: "",
      groupByFieldId: null,
      collapsedGroupKeys: [],
      aggregations: {},
      rowColor: { mode: "none", conditions: [] },
      coverFieldId: null,
      cardFieldIds: [],
      kanbanFieldId: null,
      dateFieldId: null,
      formFields: [],
      formTitle: "",
      formDescription: "",
      detailFieldIds: [],
      detailLayout: null,
    };
  }
}
