// apps/api/src/domain/queryPlan/fetch.ts
// M1/S7：S6 planner 与 S7 keyset 分页共用的取数/重排原语。
// 按 id 批量拉活行 RawRecord（IN 分批避开 SQLite 变量上限），再按给定 id 顺序重排
//（SQL IN 不保证顺序；hydrate 也可能因关联缺失丢行，重排时按实际存在为准）。

import { prisma } from "../../db.js";
import { toRawRecord } from "../prismaDeps.js";
import type { HydratedRecord, RawRecord } from "../types.js";

const IN_BATCH = 900; // SQLite 变量上限保守批

/** 按 id 集合批量拉取活记录（deletedAt:null）；返回顺序不保证，调用方用 orderByIds 重排。 */
export async function fetchRawByIds(tableId: string, ids: string[]): Promise<RawRecord[]> {
  const out: RawRecord[] = [];
  for (let i = 0; i < ids.length; i += IN_BATCH) {
    const slice = ids.slice(i, i + IN_BATCH);
    const rows = await prisma.record.findMany({
      where: { id: { in: slice }, tableId, deletedAt: null },
    });
    for (const r of rows) out.push(toRawRecord(r));
  }
  return out;
}

/** 按给定 id 顺序重排 hydrate 结果（跳过已不存在的 id——理论不可达，防御性）。 */
export function orderByIds(records: HydratedRecord[], ids: string[]): HydratedRecord[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const ordered: HydratedRecord[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) ordered.push(r);
  }
  return ordered;
}
