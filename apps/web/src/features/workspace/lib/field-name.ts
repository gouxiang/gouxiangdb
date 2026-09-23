// 字段名同表唯一：输入侧的即时校验（后端 409 是第二道，不替代）。
//
// 口径对齐后端：同 tableId 内 trim 后精确唯一，改名时排除自己；纯空格交 400
// （前端「未填名」禁用与这里的判重是两条独立的提示，不叠加红字）。
// 前端不做大小写归一化与全角折叠 —— 后端是精确字符串判重，两边口径必须一致，
// 否则会出现「前端放行、后端 409」或「前端误拦、字段改不了名」两种反向偏差。
//
// 列表来源 useFields(tableId)（api/hooks.ts）：与字段编辑器 / grid 共用同一个
// queryKey，重复调用不新增请求。

/** 判重只需要 id + name（FieldDTO 结构上可直接赋给本接口）。 */
export interface FieldNameRef {
  id: string;
  name: string;
}

/**
 * 返回与 `rawName` 冲突的名字（已 trim，可直接进提示文案）；无冲突返回 null。
 *
 * `excludeId` 是改名场景的回归锁：打开抽屉不改名直接保存、或只改了个空格，
 * 命中的是自己那一行，必须放行（后端同口径排除当前 fieldId）。
 */
export function findFieldNameConflict(
  fields: readonly FieldNameRef[] | undefined | null,
  rawName: string,
  excludeId?: string,
): string | null {
  const name = rawName.trim();
  if (!name) return null;
  for (const f of fields ?? []) {
    if (excludeId !== undefined && f.id === excludeId) continue;
    if (f.name.trim() === name) return name;
  }
  return null;
}

/** 冲突文案：与后端 409 同一句，补上可执行的下一步。 */
export function fieldNameConflictMessage(name: string): string {
  return `字段名「${name}」已存在，请换一个`;
}
