// apps/api/src/domain/queryPlan/planBuild.ts
// M1/S7：S6 planner 与 S7 keyset 分页共用的「视图配置 → 物理计划」编译步骤。
// 负责查主字段、构造 PlanField、调 compilePlan，并给出表尾聚合能否全下推的判定。
// 纯编排：不含取数/分页逻辑，保证两条读路径对同一份 ViewConfig 产出完全相同的物理计划。

import type { ViewConfig } from "@gx/shared-types";
import { prisma } from "../../db.js";
import type { FieldMeta } from "../types.js";
import { compilePlan, physicalAggFuncs, type CompiledPlan, type PlanField } from "./compile.js";

export interface BuiltPlan {
  planFields: PlanField[];
  plan: CompiledPlan;
  primaryFieldId: string;
}

/**
 * 编译一个视图的物理计划。主字段即便物理类型是 longText 也按文本入索引
 *（compilePlan 需 isPrimary 标记，短文本 LIKE/等值白名单据此放行）。
 */
export async function buildViewPlan(
  tableId: string,
  fields: FieldMeta[],
  filters: ViewConfig["filters"],
  sorts: ViewConfig["sorts"],
): Promise<BuiltPlan> {
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
  const plan = compilePlan(tableId, planFields, filters ?? null, sorts ?? []);
  return { planFields, plan, primaryFieldId };
}

/** 表尾聚合是否每个字段的每个函数都能物理下推；否则整查询回宽口径（与 S6 门控一致）。 */
export function aggregationsFullyPhysical(fields: FieldMeta[], config: ViewConfig): boolean {
  const funcs = config.aggregations ?? {};
  for (const [fid, fn] of Object.entries(funcs)) {
    if (!fn) continue;
    const f = fields.find((x) => x.id === fid);
    if (!f) return false;
    if (physicalAggFuncs(f.type, [fn]).length !== 1) return false;
  }
  return true;
}
