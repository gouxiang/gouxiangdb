// apps/api/src/domain/restoreName.ts
// 回收站「恢复」时的同名去歧义命名。
//
// 缺陷背景（T-1）：删除字段/表 -> 新建同名的新字段/新表 -> 从回收站恢复旧的那个，
// 会在同一张表 / 同一个 Base 里落下两个同名活实体，导致公式 `{字段名}` 引用歧义、
// CSV 导入按列名匹配歧义、侧栏出现两个同名项。
//
// 与「新建」路径不同，恢复不能被 409 拒绝（回收站里的东西必须能拿回来），
// 因此这里改为：恢复前查重名，原名已被占用则自动改名为 `<原名>（已恢复）`，
// 仍冲突则追加序号 `（已恢复 2）`、`（已恢复 3）`……直到不冲突。
// 超过上限（99）时放弃改名、按原名恢复，让冲突保持可见（绝不静默丢实体）。

import type { DbTx } from "../db.js";

/** 首个候选后缀。 */
const RESTORE_SUFFIX = "（已恢复）";
/** 序号候选上限（第 2 个候选起带序号）。超过则返回原名。 */
const RESTORE_SUFFIX_MAX = 99;

/** 候选名序列：`X（已恢复）`、`X（已恢复 2）`……`X（已恢复 max）`。 */
function restoreCandidateNames(name: string, max: number = RESTORE_SUFFIX_MAX): string[] {
  const out: string[] = [`${name}${RESTORE_SUFFIX}`];
  for (let i = 2; i <= max; i++) out.push(`${name}（已恢复 ${i}）`);
  return out;
}

function pickFirstFree(name: string, candidates: string[], taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (const c of candidates) if (!taken.has(c)) return c;
  // 全部候选都被占用：不改名，冲突可见（不无限追加、不静默改坏名字）。
  return name;
}

/**
 * 字段恢复前的名字裁决：同 `tableId` 下是否已有同名活字段（排除自己）。
 * 单次查询取回所有候选的占用情况，避免逐个候选往返。
 */
export async function resolveFieldRestoreName(
  client: DbTx,
  fieldId: string,
  tableId: string,
  name: string,
): Promise<string> {
  const candidates = restoreCandidateNames(name);
  const taken = await client.field.findMany({
    where: { tableId, deletedAt: null, id: { not: fieldId }, name: { in: [name, ...candidates] } },
    select: { name: true },
  });
  return pickFirstFree(name, candidates, new Set(taken.map((f) => f.name)));
}

/**
 * 表恢复前的名字裁决：同 `baseId` 下是否已有同名活表（排除自己）。
 * 必须在 `withWriteTx` 回调内用传入的 `tx` 调用（写队列并发度 1，回调内再入队会自死锁）。
 */
export async function resolveTableRestoreName(
  client: DbTx,
  tableId: string,
  baseId: string,
  name: string,
): Promise<string> {
  const candidates = restoreCandidateNames(name);
  const taken = await client.table.findMany({
    where: { baseId, deletedAt: null, id: { not: tableId }, name: { in: [name, ...candidates] } },
    select: { name: true },
  });
  return pickFirstFree(name, candidates, new Set(taken.map((t) => t.name)));
}
