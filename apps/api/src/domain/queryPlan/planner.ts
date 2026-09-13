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

import type { AggFunc, ViewConfig, SortSpec } from "@gx/shared-types";
import { prisma } from "../../db.js";
import type { HydratedRecord, FieldMeta, RawRecord } from "../types.js";
import { toRawRecord, prismaDeps } from "../prismaDeps.js";
import { hydrateRecords } from "../hydrate.js";
import { applyViewQuery } from "../recordService.js";
import { assembleGroups, assembleAggregations } from "./assemble.js";
import { compilePlan, physicalAggFuncs } from "./compile.js";
import type { SidecarQuerier } from "./sidecarQuery.js";
import { resolveInMemLimit } from "./flags.js";

export interface PlannerInput {
  tableId: string;
  fields: FieldMeta[];
  config: ViewConfig;
  search: string;
  limit: number;
  offset: number;
  noPaging: boolean;
}

export interface PlannerResult {
  records: HydratedRecord[];
  total: number;
  filteredTotal: number;
  groups: PlannerGroups;
  aggregations: Record<string, number | null> | null;
  /** 走了哪一档（供日志/对拍/后续 S7 观测）。 */
  mode: "physical" | "wide";
  /** 宽口径候选超限时为 true（计算字段大表，S8 置灰候选）。 */
  degraded: boolean;
}

type PlannerGroups = Awaited<ReturnType<typeof assembleGroups>>;

const IN_BATCH = 900; // SQLite 变量上限保守批

async function fetchRawByIds(tableId: string, ids: string[]): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for (let i = 0; i < ids.length; i += IN_BATCH) {
    const slice = ids.slice(i, i + IN_BATCH);
    const rows = await prisma.record.findMany({ where: { id: { in: slice }, tableId, deletedAt: null } });
    for (const r of rows) out.push(toRawRecord(r));
  }
  return out;
}

/** 按给定 id 顺序重排（IN 不保证顺序）。 */
function orderByIds(records: HydratedRecord[], ids: string[]): HydratedRecord[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const ordered: HydratedRecord[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) ordered.push(r);
  }
  return ordered;
}

/** 表尾聚合是否每个字段的每个函数都能物理下推；否则整查询回宽口径。 */
function aggregationsFullyPhysical(fields: FieldMeta[], config: ViewConfig): boolean {
  const funcs = config.aggregations ?? {};
  for (const [fid, fn] of Object.entries(funcs)) {
    if (!fn) continue;
    const f = fields.find((x) => x.id === fid);
    if (!f) return false;
    if (physicalAggFuncs(f.type, [fn]).length !== 1) return false;
  }
  return true;
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
  // 主字段即便物理类型是 longText 也按文本入索引（compilePlan 需 isPrimary 标记）。
  const table = await prisma.table.findUnique({
    where: { id: tableId },
    select: { primaryFieldId: true },
  });
  const primaryFieldId = table?.primaryFieldId ?? "";
  const planFields = fields.map((f) => ({
    id: f.id,
    type: f.type,
    isPrimary: f.id === primaryFieldId || undefined,
  }));
  const plan = compilePlan(tableId, planFields, filters, sorts);

  const total = q.countPhysical({ tableId, filterSql: null, filterParams: [] });
  const hasSearch = input.search.trim() !== "";
  const hasGroup = Boolean(config.groupByFieldId);
  const aggPhysical = aggregationsFullyPhysical(fields, config);

  // 物理有序候选 ids（物理过滤 + 物理排序，tie-break createdAt,id）。
  const candidateIds = q.physicalOrderedIds({
    tableId,
    filterSql: plan.filterSql,
    filterParams: plan.filterParams,
    sortJoins: plan.sortJoins,
  });

  const cleanSort =
    plan.sortJoins === null
      ? sorts.length === 0 // 无排序：无所谓洁净
      : q.sortNumericClean({
          tableId,
          fieldIds: plan.sortJoins.map((s) => s.fieldId),
          filterSql: plan.filterSql,
          filterParams: plan.filterParams,
        });

  const physicalEligible =
    plan.filtersFullyPhysical &&
    !hasSearch &&
    !hasGroup &&
    cleanSort &&
    (sorts.length === 0 || plan.sortJoins !== null) &&
    aggPhysical;

  // ---- A. 纯物理快速档 ----
  if (physicalEligible) {
    const filteredTotal = q.countPhysical({
      tableId,
      filterSql: plan.filterSql,
      filterParams: plan.filterParams,
    });
    const pageIds = input.noPaging
      ? candidateIds
      : candidateIds.slice(input.offset, input.offset + input.limit);
    const raw = await fetchRawByIds(tableId, pageIds);
    const hydrated = orderByIds(await hydrateRecords(raw, fields, prismaDeps), pageIds);
    const aggregations = physicalAggregations(q, tableId, fields, config, plan);
    return { records: hydrated, total, filteredTotal, groups: null, aggregations, mode: "physical", degraded: false };
  }

  // ---- B. 受限宽口径 ----
  // 进入此档必然至少一项需内存：残余过滤/搜索/分组/排序未全下推/聚合不可全下推。
  // 候选超限且确有内存精修负担（残余过滤 或 搜索 或 排序需内存）→ 标记计算字段大表降级。
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
  let hydrated = await hydrateRecords(raw, fields, prismaDeps);
  // 与 S5 完全相同的后处理（完整 evalFilter/search/sort），物理候选是超集，精修后逐值一致。
  hydrated = applyViewQuery(hydrated, fields, config, input.search);
  const filteredTotal = hydrated.length;
  const groups = assembleGroups(hydrated, fields, config);
  const aggregations = assembleAggregations(hydrated, config.aggregations ?? {});
  if (!input.noPaging) {
    hydrated = hydrated.slice(input.offset, input.offset + input.limit);
  }
  return { records: hydrated, total, filteredTotal, groups, aggregations, mode: "wide", degraded };
}

function physicalAggregations(
  q: SidecarQuerier,
  tableId: string,
  fields: FieldMeta[],
  config: ViewConfig,
  plan: ReturnType<typeof compilePlan>,
): Record<string, number | null> | null {
  const funcs = config.aggregations ?? {};
  if (Object.keys(funcs).length === 0) return null;
  const out: Record<string, number | null> = {};
  for (const [fid, fn] of Object.entries(funcs)) {
    if (!fn) continue;
    const f = fields.find((x) => x.id === fid)!;
    const pushable = physicalAggFuncs(f.type, [fn]);
    if (pushable.length !== 1) {
      out[fid] = null; // 理论不可达（physicalEligible 已门控），防御性
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
