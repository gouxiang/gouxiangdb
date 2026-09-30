// apps/web/src/features/designer/viewAdminFields.ts
// 视图管理员配置（#560）字段列表的纯函数层：无 React / 无网络依赖，可单测。
//
// 操作对象是 ViewAdminConfig 上的若干「字段 id 数组」：
//   - fieldOrder：全部参与排序字段的列序（非空即作为视图统一列序）；
//   - hiddenFieldIds：强制隐藏字段；
//   - cardFieldIds / detailFieldIds：画廊卡片 / 详情字段范围。
// 约定：所有函数都不可变地返回新数组；越界 / 目标不存在时原样返回，不产生副作用。

export type MoveDir = -1 | 1;

/** 已在列表中则移出，否则加入（追加到末尾）。 */
export function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * 隐藏开关：勾掉可见性 → id 进入 hiddenFieldIds；恢复可见 → 移出。
 * 与 toggleId 同语义，独立命名让调用处语义明确，也便于测试直接锚定隐藏行为。
 */
export function toggleHidden(hiddenFieldIds: readonly string[], id: string): string[] {
  return toggleId(hiddenFieldIds, id);
}

/**
 * 让排序数组覆盖全部参与排序字段：
 *  - 先剔除 order 中已不在 allIds 里的 id（字段被删除后不残留幽灵列）；
 *  - 再把 allIds 里未出现过的 id 按其在 allIds 中的顺序追加到末尾。
 * allIds 自身的重复项按首次出现去重。
 */
export function ensureOrder(order: readonly string[], allIds: readonly string[]): string[] {
  const known = new Set(allIds);
  const kept = order.filter((id, i) => known.has(id) && order.indexOf(id) === i);
  const seen = new Set(kept);
  const appended = allIds.filter((id) => !seen.has(id));
  return [...kept, ...appended];
}

/**
 * 在列序数组中上移（dir=-1）/ 下移（dir=+1）某字段：
 *  - id 不在 order 中，或已处于该方向边界 → 原样返回；
 *  - 调用方应先用 ensureOrder 让 order 覆盖全部字段，保证「未排序字段」也能移动。
 */
export function moveField(order: readonly string[], id: string, dir: MoveDir): string[] {
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const out = [...order];
  const [it] = out.splice(i, 1);
  out.splice(j, 0, it);
  return out;
}
