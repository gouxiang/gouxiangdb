// M2/S3 部门树领域：物化路径（materialized path）纯函数 + 基于事务的子树原语。
//
// path 规则（同 M2 计划 §5-B / ARCH §4.1）：
//   "/" + 各级 departmentId 以 "/" 连接，首尾均 "/"；根部门 path = "/{id}/"。
//   path 永远可由 parentId 链重算，是派生数据（可全量重建）。
// 子树查询走 "path" LIKE 前缀（Prisma startsWith -> `path LIKE 'x%'`，命中 departments_path_idx）。
// 本文件不出现 Hono/请求对象，纯逻辑便于单测；tx 原语只接收传入事务，回调内不再入队。

import type { DbTx } from "../../db.js";

/** 应用层深度护栏：移动/重写后最深层级不得超过 32（护栏而非功能上限，不对客宣传）。 */
export const MAX_DEPTH = 32;

/** 部门名长度上限（与展示侧一致的保守值）。 */
export const MAX_DEPT_NAME_LEN = 60;

export interface DeptPathRow {
  id: string;
  parentId: string | null;
  path: string;
}

/** 由父 path 与自身 id 拼自身物化路径；parentPath=null 表示根级。 */
export function selfPath(parentPath: string | null, id: string): string {
  return parentPath === null || parentPath === "" ? `/${id}/` : `${parentPath}${id}/`;
}

/** 计算 path 的层级深度："/a/b/" -> 2，"/a/" -> 1。 */
export function depthOfPath(path: string): number {
  return path.split("/").filter(Boolean).length;
}

/**
 * candidatePath 是否为 ancestorPath 自身或其后代（前缀判定）。
 * 祖先给部门授角色时，其任意子部门成员都命中；移动防环也复用它。
 */
export function isSelfOrDescendant(ancestorPath: string, candidatePath: string): boolean {
  return candidatePath === ancestorPath || candidatePath.startsWith(ancestorPath);
}

/**
 * 移动防环：若新父是被移动部门自身或其子孙，则会成环。
 * newParentPath=null（移到根）永不环。
 */
export function wouldCreateCycle(selfPathValue: string, newParentPath: string | null): boolean {
  if (newParentPath === null || newParentPath === "") return false;
  return isSelfOrDescendant(selfPathValue, newParentPath);
}

/**
 * 子树单行 path 重写公式：保留相对被移动节点的后缀，接到新自身路径之后。
 * 例：oldSelf="/a/" newSelf="/x/a/"，后代 old="/a/b/" -> "/x/a/b/"。
 */
export function rewriteSubtreePath(oldPath: string, oldSelfPath: string, newSelfPath: string): string {
  return newSelfPath + oldPath.slice(oldSelfPath.length);
}

/** 校验并归一部门名：去首尾空白，非空且不超长；非法抛 Error（service 转 HttpError 400）。 */
export function validateDeptName(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("部门名称必须是字符串");
  const name = raw.trim();
  if (name.length === 0) throw new Error("部门名称不能为空");
  if (name.length > MAX_DEPT_NAME_LEN) throw new Error(`部门名称不能超过 ${MAX_DEPT_NAME_LEN} 个字符`);
  return name;
}

/** 列出某部门自身及其全部后代（path 前缀一条查询，命中 path 索引）。 */
export async function listSubtreeTx(
  tx: DbTx,
  workspaceId: string,
  subtreeRootPath: string,
): Promise<DeptPathRow[]> {
  const rows = await tx.department.findMany({
    where: { workspaceId, deletedAt: null, path: { startsWith: subtreeRootPath } },
    select: { id: true, parentId: true, path: true },
  });
  // 前缀结果按 path 排序，保证父在子前，重写/校验顺序稳定。
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface SubtreeRewrite {
  id: string;
  newPath: string;
}

/**
 * 计算整棵子树（含自身）移动后的 path 变更集，并做深度护栏校验。
 * 不触碰数据库——纯函数，供 service 在 withWriteTx 内先算后写。
 */
export function planSubtreeRewrite(
  subtreeInput: DeptPathRow[],
  oldSelfPath: string,
  newSelfPath: string,
): SubtreeRewrite[] {
  // 按 path 排序保证父在子前（无论入参顺序），应用 update 顺序稳定。
  const subtree = [...subtreeInput].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const updates: SubtreeRewrite[] = [];
  let maxDepth = 0;
  for (const row of subtree) {
    const next = rewriteSubtreePath(row.path, oldSelfPath, newSelfPath);
    maxDepth = Math.max(maxDepth, depthOfPath(next));
    updates.push({ id: row.id, newPath: next });
  }
  if (maxDepth > MAX_DEPTH) {
    throw new Error(`部门层级不能超过 ${MAX_DEPTH} 层`);
  }
  return updates;
}

/** 在事务内逐行应用 path 变更（参数化 update；500 人组织子树行数极小）。 */
export async function applySubtreeRewriteTx(tx: DbTx, updates: SubtreeRewrite[]): Promise<void> {
  for (const u of updates) {
    await tx.department.update({ where: { id: u.id }, data: { path: u.newPath } });
  }
}
