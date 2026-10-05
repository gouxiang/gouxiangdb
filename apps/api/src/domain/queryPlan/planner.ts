// apps/api/src/domain/queryPlan/planner.ts
// M1/S6 读计划器编排（on 模式）。在 GX_M1_SIDECAR_READ=on 且写侧未停时取代 S5 的
// 「全表 hydrate」起点，但 QueryResult 契约一字段不变、结果逐值与 S5 等价（见对拍测试）。
//
// 两档：
//  A. 纯物理快速档（无 residual、无搜索、排序全 valueNum 且洁净、无分组、表尾聚合全可下推）：
//     物理过滤 → 物理有序候选 ids；filteredTotal=物理计数；只 hydrate【当页】ids；
//     表尾聚合走 sidecar physicalAggregates。groups 必为 null（本档要求无 groupBy）。
//  B. 受限宽口径（其他一切情况）：物理粗筛得到候选 ids【超集】（无物理谓词时即全表），
//     只拉候选 RawRecord + S5 批量 hydrate（不再 hydrate 被物理谓词排除的行），随后跑与
//     S5【完全相同】的 applyViewQuery 精修（完整 evalFilter/search/sort）与 assemble 分组/聚合，
//     再 slice 分页。最终序/分组/聚合由同一内存函数产出，故与 S5 逐值一致。
//
// 搜索（跨字段 contains）、计算字段残余筛选/排序、分组一律走宽口径；候选超 GX_M1_INMEM_LIMIT
// 且含残余/计算排序/搜索时打 degraded 标志（S6 仅内部标记+日志，S7 additive 暴露，S8 置灰）。
//
// M1/S7：plan 编译与取数/重排原语抽到 planBuild.ts/fetch.ts 供 keyset 分页同源复用。

import type { AggFunc, ViewConfig, SortSpec } from "@gx/shared-types";
import type { HydratedRecord, FieldMeta } from "../types.js";
import type { HydrateDeps } from "../hydrate.js";
import { hydrateRecords } from "../hydrate.js";
import { applyViewQuery } from "../recordService.js";
import { assembleGroups, assembleAggregations } from "./assemble.js";
import { physicalAggFuncs } from "./compile.js";
import type { SidecarQuerier } from "./sidecarQuery.js";
import { resolveInMemLimit } from "./flags.js";
import { buildViewPlan, aggregationsFullyPhysical } from "./planBuild.js";
import { fetchRawByIds, orderByIds } from "./fetch.js";
import { prismaDeps } from "../prismaDeps.js";

interface PlannerInput {
  tableId: string;
  fields: FieldMeta[];
  config: ViewConfig;
  search: string;
  limit: number;
  offset: number;
  noPaging: boolean;
  /** M4/S6：携带跨表可见性钩子的 hydration 依赖（缺省 prismaDeps，行为与 M3 一致）。 */
  hydrateDeps?: HydrateDeps;
  /** M4/S6：掩码外字段集（编译期物理下推兜底，缺省空集）。 */
  deniedFieldIds?: ReadonlySet<string> | null;
  /** 当前登录用户 id（动态 currentUser 真源）；分享外链/未登录缺省 → fail-closed。 */
  currentUserId?: string | null;
}

interface PlannerResult {
  records: HydratedRecord[];
  total: number;
  filteredTotal: number;
  groups: PlannerGroups;
  aggregations: Record<string, number | null> | null;
  /** 走了哪一档（供日志/对拍/S7 观测）。 */
  mode: "physical" | "wide";
  /** 宽口径候选超限时为 true（计算字段大表，S8 置灰候选）。 */
  degraded: boolean;
}

type PlannerGroups = Awaited<ReturnType<typeof assembleGroups>>;

/** S6 A 档门控：过滤/搜索/分组/排序/聚合是否全部可走纯物理路径。 */
export function physicalPathEligible(args: {
  filtersFullyPhysical: boolean;
  hasSearch: boolean;
  hasGroup: boolean;
  cleanSort: boolean;
  hasSorts: boolean;
  sortJoinsReady: boolean;
  aggPhysical: boolean;
}): boolean {
  return (
    args.filtersFullyPhysical &&
    !args.hasSearch &&
    !args.hasGroup &&
    args.cleanSort &&
    (!args.hasSorts || args.sortJoinsReady) &&
    args.aggPhysical
  );
}

/**
 * 跑读计划器。querier 由调用方按环境注入（生产进程单例、测试临时库）。
 * total 恒为表内活行（与 S5 rows.length 同口径，用物理 count，不再依赖拉全表）。
 */
export async function runQueryPlan(
  q: SidecarQuerier,
  input: PlannerInput,
): Promise<PlannerResult> {
  const { tableId, fields, config } = input;
  const filters = (config.filters ?? null) as PlannerInput["config"]["filters"];
  const sorts = (config.sorts ?? []) as SortSpec[];
  const hydrateDeps = input.hydrateDeps ?? prismaDeps;
  const denied = input.deniedFieldIds ?? null;
  const { plan } = await buildViewPlan(tableId, fields, filters, sorts, denied, input.currentUserId ?? null);

  const total = q.countPhysical({ tableId, filterSql: null, filterParams: [] });
  const hasSearch = input.search.trim() !== "";
  const hasGroup = Boolean(config.groupByFieldId);
  const aggPhysical = aggregationsFullyPhysical(fields, config);

  const cleanSort =
    plan.sortJoins === null
      ? sorts.length === 0 // 无排序：无所谓洁净
      : q.sortNumericClean({
          tableId,
          fieldIds: plan.sortJoins.map((s) => s.fieldId),
          filterSql: plan.filterSql,
          filterParams: plan.filterParams,
        });

  const eligible = physicalPathEligible({
    filtersFullyPhysical: plan.filtersFullyPhysical,
    hasSearch,
    hasGroup,
    cleanSort,
    hasSorts: sorts.length > 0,
    sortJoinsReady: plan.sortJoins !== null,
    aggPhysical,
  });

  const filter = { filterSql: plan.filterSql, filterParams: plan.filterParams, countPlan: plan.countPlan };

  // ---- A. 纯物理快速档 ----
  if (eligible) {
    const filteredTotal = q.countPhysical({ tableId, ...filter });
    // 无排序 + 分页：直接按 (createdAt,id) 索引 seek 取当页，不物化全量候选
    //（高命中范围过滤从全表 N 行降到一页，消除双相关 EXISTS 的 O(n²) 放大）。
    const pageIds =
      !input.noPaging && sorts.length === 0
        ? q.physicalCreatedPage({ tableId, ...filter }, input.offset, input.limit)
        : null;
    if (pageIds !== null) {
      const raw = await fetchRawByIds(tableId, pageIds);
      const hydrated = orderByIds(await hydrateRecords(raw, fields, hydrateDeps), pageIds);
      const aggregations = physicalAggregations(q, tableId, fields, config, plan);
      return { records: hydrated, total, filteredTotal, groups: null, aggregations, mode: "physical", degraded: false };
    }
    // 导出（noPaging）或物理排序档：仍需完整有序候选序列。
    const candidateIds = q.physicalOrderedIds({ tableId, ...filter, sortJoins: plan.sortJoins });
    const sliceIds = input.noPaging
      ? candidateIds
      : candidateIds.slice(input.offset, input.offset + input.limit);
    const raw = await fetchRawByIds(tableId, sliceIds);
    const hydrated = orderByIds(await hydrateRecords(raw, fields, hydrateDeps), sliceIds);
    const aggregations = physicalAggregations(q, tableId, fields, config, plan);
    return { records: hydrated, total, filteredTotal, groups: null, aggregations, mode: "physical", degraded: false };
  }

  // ---- B. 受限宽口径 ----
  // 进入此档必然至少一项需内存：残余过滤/搜索/分组/排序未全下推/聚合不可全下推。
  // 物理粗筛得到候选【超集】（无排序即 createdAt 序），后续整段 hydrate + S5 同一精修。
  const candidateIds = q.physicalOrderedIds({ tableId, ...filter, sortJoins: plan.sortJoins });
  const needsMemSort = sorts.length > 0 && plan.sortJoins === null;
  const degraded =
    candidateIds.length > resolveInMemLimit() &&
    (plan.residual !== null || hasSearch || needsMemSort);
  if (degraded) {
    console.warn(
      `[queryPlan] 宽口径候选 ${candidateIds.length} 超 GX_M1_INMEM_LIMIT=${resolveInMemLimit()} ` +
      `且含计算/搜索口径，table=${tableId}（S8 应对计算字段排序/筛选置灰）`,
    );
  }

  const raw = await fetchRawByIds(tableId, candidateIds);
  let hydrated = await hydrateRecords(raw, fields, hydrateDeps);
  // 与 S5 完全相同的后处理（完整 evalFilter/search/sort），物理候选是超集，精修后逐值一致。
  hydrated = applyViewQuery(hydrated, fields, config, input.search, input.currentUserId ?? null);
  const filteredTotal = hydrated.length;
  const groups = assembleGroups(hydrated, fields, config);
  const aggregations = assembleAggregations(hydrated, config.aggregations ?? {});
  if (!input.noPaging) {
    hydrated = hydrated.slice(input.offset, input.offset + input.limit);
  }
  return { records: hydrated, total, filteredTotal, groups, aggregations, mode: "wide", degraded };
}

/**
 * A 档表尾物理聚合（S7 keyset T1/T2 同源复用）：逐字段按 physicalAggFuncs 下推，
 * percent* 在执行器内推导。调用前须已用 aggregationsFullyPhysical 门控。
 */
export function physicalAggregations(
  q: SidecarQuerier,
  tableId: string,
  fields: FieldMeta[],
  config: ViewConfig,
  plan: Awaited<ReturnType<typeof buildViewPlan>>["plan"],
): Record<string, number | null> | null {
  const funcs = config.aggregations ?? {};
  if (Object.keys(funcs).length === 0) return null;
  const out: Record<string, number | null> = {};
  for (const [fid, fn] of Object.entries(funcs)) {
    if (!fn) continue;
    const f = fields.find((x) => x.id === fid)!;
    const pushable = physicalAggFuncs(f.type, [fn]);
    if (pushable.length !== 1) {
      out[fid] = null; // 理论不可达（门控已保证），防御性
      continue;
    }
    const got = q.physicalAggregates({
      tableId,
      fieldId: fid,
      funcs: [fn as AggFunc],
      filterSql: plan.filterSql,
      filterParams: plan.filterParams,
    });
    out[fid] = got[fn] ?? null;
  }
  return out;
}
