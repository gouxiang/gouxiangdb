// 库名 / 知识库名全局唯一：输入侧的即时校验（后端 409 是第二道，不替代）。
//
// 口径对齐后端：数据库与知识库【全局】唯一 —— 同一个名字既不能被另一个数据库占用，
// 也不能被任何知识库占用，判重时必须把 bases 与 kbs 合并成一个集合。
// 前端不做大小写归一化与全角折叠，只做 trim 后精确字符串比较，否则会出现
// 「前端放行、后端 409」或「前端误拦、改名保存不了」两种反向偏差。
//
// 列表来源 useBases()（api/hooks.ts）与 useKbList()（features/kb/kb-hooks.ts）：
// 两个接口后端都只返回 deletedAt 为 null 的活库，故这里无需再过滤删除态；
// 与 L1 导航 / 库切换器共用同一个 queryKey，重复调用不新增请求。

/** 判重只需要 id + name（BaseDTO / KbDTO 结构上可直接赋给本接口）。 */
export interface LibraryNameRef {
  id: string;
  name: string;
}

/**
 * 返回与 `rawName` 冲突的名字（已 trim，可直接进提示文案）；无冲突返回 null。
 *
 * `excludeId` 是改名场景的回归锁：打开弹窗不改名直接保存、或只改了个空格，
 * 命中的是自己那一行，必须放行。base 与 kb 在合并集合里按同一 id 排除
 * （两类 id 不同源，不会误伤对面类型的同 id 行）。
 */
export function findLibraryNameConflict(
  bases: readonly LibraryNameRef[] | undefined | null,
  kbs: readonly LibraryNameRef[] | undefined | null,
  rawName: string,
  excludeId?: string,
): string | null {
  const name = rawName.trim();
  if (!name) return null;
  for (const ref of [...(bases ?? []), ...(kbs ?? [])]) {
    if (excludeId !== undefined && ref.id === excludeId) continue;
    if (ref.name.trim() === name) return name;
  }
  return null;
}

/** 冲突文案：与后端 409 同一句，补上可执行的下一步。 */
export function libraryNameConflictMessage(name: string): string {
  return `库名「${name}」已存在，请换一个`;
}
