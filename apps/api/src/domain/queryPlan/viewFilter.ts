// apps/api/src/domain/queryPlan/viewFilter.ts
// 视图过滤段（从 recordService 抽出）：对 hydrate 完毕的记录套用 config.filters。
// 纯内存谓词；高级模式（kind:"formula"）经可选回调求布尔，无回调时 fail-closed。

import type { FilterNode } from "@gx/shared-types";
import type { FieldMeta, HydratedRecord } from "../types.js";
import { evalFilter } from "../filter.js";

/** recordId -> (expression => 严格布尔)；仅当过滤树含 formula 节点时由调用方预构造。 */
export type FormulaCallbacks = Map<string, (expression: string) => boolean>;

/**
 * 按视图 filters 过滤记录。
 * @param currentUserId 动态 currentUser 真源（分享外链/未登录缺省 → fail-closed）
 * @param formulaCallbacks 高级公式回调；未提供或某记录无回调时该记录上的 formula 节点为 false
 */
export function filterByView(
  records: HydratedRecord[],
  fields: FieldMeta[],
  filters: FilterNode | null | undefined,
  currentUserId?: string | null,
  formulaCallbacks?: FormulaCallbacks | null,
): HydratedRecord[] {
  if (!filters) return records;
  // currentUser 在内存路径按 userId 精确匹配（非显示名）：人名字段 hydrate 后 fields[]
  // 里是 resolveUserName() 的显示名，而 actor userId 在 HydratedRecord 顶层物理列
  // （createdBy / updatedBy）。getActorId 按字段类型把左值解析回 userId，
  // 与物理 records.createdBy = :uid 口径逐值一致（见 shared-types/filter.ts 注释）。
  const typeById = new Map(fields.map((f) => [f.id, f.type]));
  return records.filter((r) =>
    evalFilter(filters, (fid) => r.fields[fid], undefined, {
      vars: { currentUserId: currentUserId ?? null },
      getActorId: (fid) => {
        const t = typeById.get(fid);
        if (t === "createdBy") return r.createdBy;
        if (t === "lastModifiedBy") return r.updatedBy;
        return r.fields[fid];
      },
      evalFormula: (expression) => {
        const cb = formulaCallbacks?.get(r.id);
        // 无该记录回调（未注入 formula 求值）：fail-closed
        if (!cb) return false;
        return cb(expression) === true;
      },
    }),
  );
}
