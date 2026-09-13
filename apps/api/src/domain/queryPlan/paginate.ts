// apps/api/src/domain/queryPlan/paginate.ts
// M1/S7 keyset 分页编排（GX_M1_KEYSET=on 且 GX_M1_SIDECAR_READ=on 时取代 planner 的 offset slice）。
// 三档，全部【不使用 SQL OFFSET】，与 S6 读计划器共用同一份 plan 编译/取数/组装原语：
//
//  T1 keyset-created（无排序且过滤全物理）：直接在 (createdAt ASC,id ASC) 上用原生游标谓词
//     展开式取下一页（索引定位，不物化候选序列）。游标刻画的是【值边界】而非行引用，故边界行
//     被删/被过滤后翻页依然不重不漏（谓词与该行是否存在无关）。
//  T2 keyset-sorted（valueNum 物理排序，过滤全物理）：physicalOrderedIds 产出全物理有序 id 序列
//    （S6 A 档本就物化该序列），按上游标的 lastId 在序列中定位续点；边界行消失则 400 让客户端回首页。
//  T3 keyset-wide（残余过滤/搜索/分组/文本排序/非物理聚合）：物理粗筛超集 → 全量 hydrate →
//     与 S5 完全相同的 applyViewQuery 精修，在精修后的有序集合上按 lastId 续点；groups/aggregations
//     与 S5/S6 同为【分页前全量】口径；候选超 GX_M1_INMEM_LIMIT 且确有内存负担时 degraded 标 computedInMem。
//
// 老客户端 offset：仅允许 offset < limit × GX_M1_OFFSET_WINDOW（默认 5 页）。T1 用不超过 5 次
// 索引 seek 快进到 offset（不取多余列、不 hydrate）；T2/T3 在已物化的有序序列内定位。超窗抛
// OffsetWindowError → 路由 400。limit 钳制与 noPaging 由调用方（recordService/路由）负责。

import type { SortSpec, ViewConfig } from "@gx/shared-types";
import type { HydratedRecord, FieldMeta } from "../types.js";
import { prismaDeps } from "../prismaDeps.js";
import { hydrateRecords } from "../hydrate.js";
import { applyViewQuery } from "../recordService.js";
import { assembleGroups, assembleAggregations } from "./assemble.js";
import type { SidecarQuerier } from "./sidecarQuery.js";
import { buildViewPlan, aggregationsFullyPhysical } from "./planBuild.js";
import { fetchRawByIds, orderByIds } from "./fetch.js";
import { physicalPathEligible, physicalAggregations } from "./planner.js";
import { resolveInMemLimit, resolveOffsetWindowPages } from "./flags.js";
import { encodeCursor, decodeCursor, InvalidCursorError, OffsetWindowError } from "./cursor.js";

export interface KeysetInput {
  tableId: string;
  fields: FieldMeta[];
  config: ViewConfig;
  search: string;
  limit: number;
  offset: number;
  /** 不透明游标原文（首页为 null/undefined/""）；非法抛 InvalidCursorError。 */
  cursor: string | null | undefined;
}

export type KeysetPageMode = "keyset-created" | "keyset-sorted" | "keyset-wide";

export interface KeysetPageResult {
  records: HydratedRecord[];
  total: number;
  filteredTotal: number;
  groups: Awaited<ReturnType<typeof assembleGroups>>;
  aggregations: Record<string, number | null> | null;
  mode: KeysetPageMode;
  /** 降级原因码（无降级为空数组；M1 仅 "computedInMem"，S8 group bound 再扩 boundedPreview）。 */
  degraded: string[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** 有效偏移窗口上界（不含）：limit × 配置页数。 */
export function offsetWindowLimit(limit: number): number {
  return limit * resolveOffsetWindowPages();
}

/**
 * 跑一页 keyset 查询。querier 由 recordService 注入（生产进程单例、测试临时库）。
 */
export async function runKeysetPaging(
  q: SidecarQuerier,
  input: KeysetInput,
): Promise<KeysetPageResult> {
  const { tableId, fields, config } = input;
  const limit = input.limit;
  const sorts = (config.sorts ?? []) as SortSpec[];
  const rawCursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (input.cursor && !rawCursor) throw new InvalidCursorError();
  const hasCursor = rawCursor !== null;
  if (!hasCursor && input.offset >= offsetWindowLimit(limit)) {
    throw new OffsetWindowError(limit, resolveOffsetWindowPages());
  }

  const { plan } = await buildViewPlan(tableId, fields, config.filters ?? null, sorts);
  const total = q.countPhysical({ tableId, filterSql: null, filterParams: [] });
  const hasSearch = input.search.trim() !== "";
  const hasGroup = Boolean(config.groupByFieldId);
  const aggPhysical = aggregationsFullyPhysical(fields, config);

  const filter = { filterSql: plan.filterSql, filterParams: plan.filterParams, countPlan: plan.countPlan };
  const cleanSort =
    plan.sortJoins === null
      ? sorts.length === 0
      : q.sortNumericClean({ tableId, fieldIds: plan.sortJoins.map((s) => s.fieldId), ...filter });
  const eligible = physicalPathEligible({
    filtersFullyPhysical: plan.filtersFullyPhysical,
    hasSearch,
    hasGroup,
    cleanSort,
    hasSorts: sorts.length > 0,
    sortJoinsReady: plan.sortJoins !== null,
    aggPhysical,
  });

  // T1（无排序且全物理）走原生 createdAt keyset 索引取页，【绝不】物化全量候选序列；
  // 旧实现无条件先跑 physicalOrderedIds，让高命中范围过滤在分页前就把整表物化（S10 6.9s 真因）。
  if (eligible && sorts.length === 0) {
    return await pageCreated(q, input, plan, rawCursor, total);
  }

  // T2（物理排序）/ T3（宽口径）才需要物化候选序列：T2 在其上续点，T3 整段 hydrate 精修。
  const candidateIds = q.physicalOrderedIds({ tableId, ...filter, sortJoins: plan.sortJoins });
  if (eligible) {
    return await pageSorted(q, input, plan, candidateIds, rawCursor, total);
  }
  return await pageWide(q, input, plan, candidateIds, rawCursor, total, sorts);
}

/** T1：原生 (createdAt,id) 游标；offset 用索引 seek 快进（≤ 窗口页数次）。 */
async function pageCreated(
  q: SidecarQuerier,
  input: KeysetInput,
  plan: Awaited<ReturnType<typeof buildViewPlan>>["plan"],
  rawCursor: { c: number; id: string } | null,
  total: number,
): Promise<KeysetPageResult> {
  const { tableId, fields, config, limit, offset } = input;
  const filter = { filterSql: plan.filterSql, filterParams: plan.filterParams, countPlan: plan.countPlan };
  const filteredTotal = q.countPhysical({ tableId, ...filter });

  // 无游标但带老 offset：逐页 seek 恰好前进 offset 行，把游标定位到目标行的【前一行】。
  let startCursor = rawCursor ? { createdAt: rawCursor.c, id: rawCursor.id } : null;
  if (!rawCursor && offset > 0) {
    let remaining = offset;
    while (remaining > 0) {
      const step = Math.min(remaining, limit);
      const p = q.physicalKeysetOnCreatedAt({ tableId, ...filter, cursor: startCursor, limit: step });
      if (p.rows.length === 0) break; // offset 越过集合末尾：游标停在最后实取行，最终页自然为空
      const last = p.rows[p.rows.length - 1]!;
      startCursor = { createdAt: last.createdAt, id: last.id };
      remaining -= p.rows.length;
      if (!p.hasMore) break; // 已到集合末尾
    }
  }

  const page = q.physicalKeysetOnCreatedAt({ tableId, ...filter, cursor: startCursor, limit });
  const ids = page.rows.map((r) => r.id);
  const raw = await fetchRawByIds(tableId, ids);
  const records = orderByIds(await hydrateRecords(raw, fields, prismaDeps), ids);
  const last = page.rows[page.rows.length - 1];
  const nextCursor = page.hasMore && last ? encodeCursor({ c: last.createdAt, id: last.id }) : null;
  return {
    records, total, filteredTotal, groups: null,
    aggregations: physicalAggregations(q, tableId, fields, config, plan),
    mode: "keyset-created", degraded: [], nextCursor, hasMore: page.hasMore,
  };
}

/** T2：物理有序 id 序列按 lastId 续点（offset 在窗口内直接定位）。 */
async function pageSorted(
  q: SidecarQuerier,
  input: KeysetInput,
  plan: Awaited<ReturnType<typeof buildViewPlan>>["plan"],
  sequence: string[],
  rawCursor: { c: number; id: string } | null,
  total: number,
): Promise<KeysetPageResult> {
  const { tableId, fields, config, limit, offset } = input;
  const start = rawCursor ? sequence.indexOf(rawCursor.id) + 1 : offset;
  if (rawCursor && start === 0) throw new InvalidCursorError(); // indexOf=-1 → 边界行已不在物理集合
  const pageIds = sequence.slice(start, start + limit);
  const raw = await fetchRawByIds(tableId, pageIds);
  const records = orderByIds(await hydrateRecords(raw, fields, prismaDeps), pageIds);
  const hasMore = start + limit < sequence.length;
  const last = records[records.length - 1];
  return {
    records, total, filteredTotal: sequence.length, groups: null,
    aggregations: physicalAggregations(q, tableId, fields, config, plan),
    mode: "keyset-sorted", degraded: [], hasMore,
    nextCursor: hasMore && last ? encodeCursor({ c: Date.parse(last.createdAt), id: last.id }) : null,
  };
}

/** T3：物理超集 → 全量 hydrate → S5 同一精修，在最终有序集合上续点。 */
async function pageWide(
  q: SidecarQuerier,
  input: KeysetInput,
  plan: Awaited<ReturnType<typeof buildViewPlan>>["plan"],
  candidateIds: string[],
  rawCursor: { c: number; id: string } | null,
  total: number,
  sorts: SortSpec[],
): Promise<KeysetPageResult> {
  const { tableId, fields, config, search, limit, offset } = input;
  const rawAll = await fetchRawByIds(tableId, candidateIds);
  let hydrated = await hydrateRecords(rawAll, fields, prismaDeps);
  hydrated = applyViewQuery(hydrated, fields, config, search);

  const needsMemSort = sorts.length > 0 && plan.sortJoins === null;
  const computedInMem =
    candidateIds.length > resolveInMemLimit() &&
    (plan.residual !== null || search.trim() !== "" || needsMemSort);
  if (computedInMem) {
    console.warn(
      `[queryPlan] keyset 宽口径候选 ${candidateIds.length} 超 GX_M1_INMEM_LIMIT=${resolveInMemLimit()}，` +
      `table=${tableId}（degraded=computedInMem）`,
    );
  }

  const start = rawCursor ? hydrated.findIndex((r) => r.id === rawCursor.id) + 1 : offset;
  if (rawCursor && start === 0) throw new InvalidCursorError();
  const pageRecords = hydrated.slice(start, start + limit);
  const hasMore = start + limit < hydrated.length;
  const last = pageRecords[pageRecords.length - 1];
  return {
    records: pageRecords,
    total,
    filteredTotal: hydrated.length,
    groups: assembleGroups(hydrated, fields, config),
    aggregations: assembleAggregations(hydrated, config.aggregations ?? {}),
    mode: "keyset-wide",
    degraded: computedInMem ? ["computedInMem"] : [],
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ c: Date.parse(last.createdAt), id: last.id }) : null,
  };
}
