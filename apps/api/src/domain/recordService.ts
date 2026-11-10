// apps/api/src/domain/recordService.ts
// 记录查询编排：hydrate → filter → search → sort → group → aggregate → paginate
//
// 这是「列表渲染」的唯一真源：Grid / Gallery / Kanban / Calendar 全部走这里，
// 保证同一份视图配置在任何视图类型下得到完全一致的数据集（v1 各视图各自实现的隐患在此消除）。

import { prisma } from "../db.js";
import type { HydratedRecord, FieldMeta } from "./types.js";
import { toFieldMeta, toRawRecord, prismaDeps } from "./prismaDeps.js";
import { hydrateRecords, type HydrateDeps } from "./hydrate.js";
import { matchesSearch } from "./filter.js";
import { sortRows } from "./sort.js";
import { assembleGroups, assembleAggregations } from "./queryPlan/assemble.js";
import { filterByView } from "./queryPlan/viewFilter.js";
import { buildFormulaCallbacks, filterHasFormulaNode } from "./queryPlan/formulaEval.js";
import { isGridSkipType } from "@gx/shared-types";
import type { FilterNode, SortSpec, ViewConfig } from "@gx/shared-types";

export interface QueryOptions {
  tableId: string;
  fields: FieldMeta[];
  config: ViewConfig;
  search?: string;
  limit?: number;
  offset?: number;
  /** 跳过分页（导出全量用；与 S7 keyset 互斥，noPaging 恒走非游标路径） */
  noPaging?: boolean;
  /** S7：不透明分页游标（base64url）；仅 GX_M1_KEYSET=on 且读=on 时被解析。 */
  cursor?: string | null;
  /**
   * M4/S6 中性依赖注入（不判 flag、不 import authz；缺省行为与 M3 一字不变）：
   *  - hydrateDeps：携带跨表字段可见性钩子的 hydration 依赖（on 态由 maskSession 注入，
   *    off/shadow 传缺省 prismaDeps，无钩子、零额外查询）；
   *  - compileDeniedFieldIds：编译期禁止物理下推的字段集（掩码外字段，纵深防御；缺省空集）。
   * 路由传入前已用【可见字段子集】与【脱敏 config】收窄，recordService 本身不含任何掩码判定。
   */
  hydrateDeps?: HydrateDeps;
  compileDeniedFieldIds?: ReadonlySet<string> | null;
  /**
   * 当前登录用户 id（动态筛选 currentUser 的唯一真源）。
   * 由路由从请求上下文透传；分享外链 / 未登录场景缺省（null/undefined）——
   * 此时含 currentUser 的条件 fail-closed（见 shared-types/filter.ts），不放开任何行。
   */
  currentUserId?: string | null;
}

export interface QueryResult {
  records: HydratedRecord[];
  total: number;
  filteredTotal: number;
  groups: { key: string; label: string; color: string | null; recordIds: string[]; aggregations: Record<string, number | null> }[] | null;
  aggregations: Record<string, number | null> | null;
  /**
   * S7 additive 三键：仅 keyset 分页真正生效（GX_M1_KEYSET=on 且 GX_M1_SIDECAR_READ=on）
   * 时出现；其余任何 flag 组合（含默认全 off）响应不含这三个键，旧客户端/S0 快照字节不变。
   */
  nextCursor?: string | null;
  hasMore?: boolean;
  /** 降级原因码，M1 仅 "computedInMem"（宽口径内存精修超阈值）。 */
  degraded?: string[];
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
 *
 * 高级模式（filters 含 kind:"formula"）时异步预构造公式回调（复用 buildFormulaSource /
 * parseCached 缓存与 hydrated 数据），无 formula 节点时走纯同步过滤、行为与旧版一致。
 */
export async function applyViewQuery(
  hydrated: HydratedRecord[],
  fields: FieldMeta[],
  config: ViewConfig,
  search: string,
  currentUserId?: string | null,
  deps?: HydrateDeps,
): Promise<HydratedRecord[]> {
  let out = hydrated;

  // 过滤
  if (config.filters) {
    const formulaCallbacks = filterHasFormulaNode(config.filters as FilterNode)
      ? await buildFormulaCallbacks(
          // B 档调用方按本表 id 与 hydration deps 注入；缺省退 prismaDeps（off/shadow 同口径）
          out[0]?.tableId ?? "",
          fields,
          config.filters as FilterNode,
          out,
          deps ?? prismaDeps,
        )
      : null;
    out = filterByView(
      out,
      fields,
      config.filters as FilterNode | null,
      currentUserId ?? null,
      formulaCallbacks,
    );
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
 * 列表查询入口（S6 读分派 + S7 keyset 分派，两级 flag）：
 *   GX_M1_SIDECAR_READ=off（默认）→ queryRecordsLegacy：全表 hydrate + 内存口径；
 *   =shadow                       → 旧结果照返回，额外跑 S6 计划器只记差异；
 *   =on 且 GX_M1_KEYSET=off（默认）→ 走 S6 queryPlan 计划器（offset slice）；
 *   =on 且 =shadow                 → S6 计划器结果照返回，额外跑 keyset 只记差异；
 *   =on 且 =on（且非 noPaging）    → 走 S7 keyset 分页（响应 additive 带游标三键）。
 * GX_M1_KEYSET=shadow 是【纯观测】档，在任意 read 档（含默认 off）都额外跑 keyset 并对拍
 * 当前主路径结果，只记差异、绝不影响响应；故默认环境即可开 shadow 收集 drift。
 * 写侧 GX_M1_SIDECAR=off、派生表异常、keyset 运行时异常均安全回退旧路径；
 * 唯坏游标/offset 超窗属客户端错误（400），不回退、直接抛给路由。
 */
export async function queryRecords(opts: QueryOptions): Promise<QueryResult> {
  const { resolveSidecarReadMode, sidecarReadUsable, resolveKeysetMode, resolveSidecarWriteEnabled } =
    await import("./queryPlan/flags.js");
  const readMode = resolveSidecarReadMode();
  const keysetMode = resolveKeysetMode();
  // shadow 是纯观测档，不要求 read=on；但写侧必须在维护 sidecar（否则派生表过期/缺失，drift 是噪音）。
  const keysetShadow = keysetMode === "shadow" && !opts.noPaging && resolveSidecarWriteEnabled();

  if (readMode === "off" || !sidecarReadUsable()) {
    const legacy = await queryRecordsLegacy(opts);
    if (keysetShadow) await runKeysetShadowAgainst(opts, legacy);
    return legacy;
  }

  if (readMode === "shadow") {
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
    if (keysetShadow) await runKeysetShadowAgainst(opts, legacy);
    return legacy;
  }

  // read=on
  if (keysetMode === "on" && !opts.noPaging) {
    try {
      const { runKeysetQuery } = await import("./queryPlan/keysetEntry.js");
      return await runKeysetQuery(opts);
      // 400 客户端错误（坏游标/超窗）必须透传，不能回退成「错误的一页」；其余异常安全回退。
    } catch (e) {
      const { isKeysetClientError } = await import("./queryPlan/keysetEntry.js");
      if (isKeysetClientError(e)) throw e;
      console.warn("[queryPlan][keyset-on] keyset 失败，回退计划器:", (e as Error).message);
    }
  }

  let planned: QueryResult;
  try {
    planned = await runPlannerOnce(opts);
  } catch (e) {
    console.warn("[queryPlan][on] 计划器失败，回退旧路径:", (e as Error).message);
    planned = await queryRecordsLegacy(opts);
  }
  if (keysetShadow) await runKeysetShadowAgainst(opts, planned);
  return planned;
}

/** keyset shadow 双跑：跑一遍 keyset 并与当前主路径结果对拍；任何异常只记日志。 */
async function runKeysetShadowAgainst(opts: QueryOptions, baseline: QueryResult): Promise<void> {
  try {
    const { runKeysetQuery, logKeysetShadowDiff } = await import("./queryPlan/keysetEntry.js");
    const keyset = await runKeysetQuery(opts);
    logKeysetShadowDiff(opts, baseline, keyset, "shadow");
  } catch (e) {
    // 坏游标在 shadow 下也不影响旧结果（on 时才转 400）；环境无 sidecar 库等同样吞掉。
    console.warn("[queryPlan][keyset-shadow] keyset 异常（忽略，返回旧结果）:", (e as Error).message);
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
    hydrateDeps: opts.hydrateDeps,
    deniedFieldIds: opts.compileDeniedFieldIds ?? null,
    currentUserId: opts.currentUserId ?? null,
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
  const hydrateDeps = opts.hydrateDeps ?? prismaDeps;

  // 1. 拉原始记录
  const rows = await prisma.record.findMany({
    where: { tableId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const total = rows.length;

  // 2. hydrate（计算字段在此现算；on 态注入的 deps 含跨表字段可见性钩子）
  let hydrated = await hydrateRecords(
    rows.map(toRawRecord),
    fields,
    hydrateDeps,
  );

  // 3-5. 视图过滤 / 搜索 / 排序（纯内存，导出与列表共用同一后处理，口径零漂移）
  hydrated = await applyViewQuery(
    hydrated,
    fields,
    config,
    search,
    opts.currentUserId ?? null,
    hydrateDeps,
  );

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
 *
 * M4/S6 可选投影（不判 flag，中性注入；缺省行为与 M3 一字不变）：
 *   opts.fields 用可见字段子集（隐藏物理列在 merged 缺席，公式引用它天然 FNULL）；
 *   opts.deps  注入含跨表可见性钩子的 hydration 依赖（LinkRef 两档/lookup 隐藏值 null）。
 */
export async function hydrateRecordById(
  tableId: string,
  recordId: string,
  opts?: { fields?: FieldMeta[]; deps?: HydrateDeps },
): Promise<HydratedRecord | null> {
  const row = await prisma.record.findUnique({ where: { id: recordId } });
  if (!row || row.deletedAt || row.tableId !== tableId) return null;
  const fields = opts?.fields ?? await loadTableFields(tableId);
  const [hydrated] = await hydrateRecords([toRawRecord(row)], fields, opts?.deps ?? prismaDeps);
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
      treeParentFieldId: null,
      ganttStartFieldId: null,
      ganttEndFieldId: null,
      ganttProgressFieldId: null,
      ganttDependencyFieldId: null,
      ganttZoom: "day",
      chartType: "bar",
      chartDimensionFieldId: null,
      chartMetricFieldId: null,
      chartAggFunc: "count",
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
      treeParentFieldId: parsed.treeParentFieldId ?? null,
      ganttStartFieldId: parsed.ganttStartFieldId ?? null,
      ganttEndFieldId: parsed.ganttEndFieldId ?? null,
      ganttProgressFieldId: parsed.ganttProgressFieldId ?? null,
      ganttDependencyFieldId: parsed.ganttDependencyFieldId ?? null,
      ganttZoom: parsed.ganttZoom ?? "day",
      chartType: parsed.chartType ?? "bar",
      chartDimensionFieldId: parsed.chartDimensionFieldId ?? null,
      chartMetricFieldId: parsed.chartMetricFieldId ?? null,
      chartAggFunc: parsed.chartAggFunc ?? "count",
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
      treeParentFieldId: null,
      ganttStartFieldId: null,
      ganttEndFieldId: null,
      ganttProgressFieldId: null,
      ganttDependencyFieldId: null,
      ganttZoom: "day",
      chartType: "bar",
      chartDimensionFieldId: null,
      chartMetricFieldId: null,
      chartAggFunc: "count",
      formFields: [],
      formTitle: "",
      formDescription: "",
      detailFieldIds: [],
      detailLayout: null,
    };
  }
}
