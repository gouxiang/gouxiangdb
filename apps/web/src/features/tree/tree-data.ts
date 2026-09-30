// 层级视图纯函数：把 records（含同表自引用 link 的 LinkRef[]）适配为建树所需的 {id,parentId,name}。
// 无 React/DOM 依赖，便于 vitest 单测。建树 / 拍平 / 窗口化直接复用 contacts/lib/tree.ts。

import type { LinkRefDTO, RecordDTO } from "@gx/shared-types";

export interface TreeRow {
  id: string;
  parentId: string | null;
  name: string;
}

/**
 * 取某条记录在自引用 link 字段上的父记录 id。
 * 该字段 hydrate 后是 LinkRefDTO[]；层级只认第一个关联作为父（多父取首）。
 * 仅接受指向同表的关联；跨表/空 -> 根（null）。
 */
export function parentIdFromLinks(
  value: unknown,
  selfTableId: string,
): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0] as Partial<LinkRefDTO> | null;
  if (!first || first.tableId !== selfTableId || !first.recordId) return null;
  return first.recordId as string;
}

/**
 * 把平铺 records 适配为建树行。
 * @param titleFieldId 主字段（用于显示名）；缺则用 id。
 * @param parentFieldId 自引用 link 字段 id。
 * 断链容错：父指向的记录不在本批 records 中时，buildDeptTree 会把它按根挂出（不丢节点）。
 */
export function toTreeRows(
  records: readonly RecordDTO[],
  parentFieldId: string | null,
  titleFieldId: string | null,
): TreeRow[] {
  return records.map((r) => {
    const name = titleFieldId
      ? String(r.fields[titleFieldId] ?? "").trim()
      : "";
    return {
      id: r.id,
      parentId: parentFieldId
        ? parentIdFromLinks(r.fields[parentFieldId], r.tableId)
        : null,
      name: name || "未命名",
    };
  });
}

/** 在树行集合中判断：把 childId 挂到 newParentId 下是否会成环（含自身/子孙）。 */
export function treeWouldCycle(
  rows: readonly TreeRow[],
  childId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === childId) return true;
  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parentId === null) continue;
    const arr = childrenOf.get(r.parentId) ?? [];
    arr.push(r.id);
    childrenOf.set(r.parentId, arr);
  }
  const seen = new Set<string>();
  const stack = [childId];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === newParentId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const c of childrenOf.get(id) ?? []) stack.push(c);
  }
  return false;
}
