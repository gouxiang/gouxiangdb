// 表名同库唯一：输入侧的即时校验（后端 409 是第二道，不替代）。
//
// 口径对齐后端 apps/api/src/routes/tables.ts 的 assertTableNameFree：
//   同库 + 未软删 + trim 后精确匹配 + 改名时排除自己。
// 前端不做大小写归一化与全角折叠 —— 后端是精确字符串判重，两边口径必须一致，
// 否则会出现「前端放行、后端 409」或「前端误拦、用户改不了名」两种反向偏差。
//
// 列表来源 useTables(baseId)（api/hooks.ts）：该接口后端只返回 deletedAt 为 null 的表，
// 故这里无需再过滤删除态；与 L2 行列表同一个 queryKey，重复调用不新增请求。

/** 判重只需要 id + name（TableDTO 结构上可直接赋给本接口）。 */
export interface TableNameRef {
  id: string;
  name: string;
}

/**
 * 返回与 `rawName` 冲突的名字（已 trim，可直接进提示文案）；无冲突返回 null。
 *
 * `excludeId` 是改名场景的回归锁：打开弹窗不改名直接保存、或只改了个空格，
 * 命中的是自己那一行，必须放行（后端同口径 `id: { not: tableId }`）。
 */
export function findTableNameConflict(
  tables: readonly TableNameRef[] | undefined | null,
  rawName: string,
  excludeId?: string,
): string | null {
  const name = rawName.trim();
  if (!name) return null;
  for (const t of tables ?? []) {
    if (excludeId !== undefined && t.id === excludeId) continue;
    if (t.name.trim() === name) return name;
  }
  return null;
}

/** 冲突文案：沿用后端 409 的同一句，补上可执行的下一步。 */
export function tableNameConflictMessage(name: string): string {
  return `表名「${name}」已存在，请换一个`;
}
