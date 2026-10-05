// M3 nav_nodes 物化路径纯函数 + 基于事务的子树原语。
//
// path 规则与 M2 departments 逐字同构（M3 计划 §4.2）：
//   "/" + 各级 navNodeId 以 "/" 连接，首尾均 "/"；根节点 path="/{id}/"。
//   path 永远可由 parentId 链重算，是派生数据（reconcile 可全量重建）。
// 子树前缀匹配命中 nav_nodes_path_idx（startsWith -> `path LIKE 'x%'`，段边界天然防误配）。
// 本文件不出现 Hono/请求对象；tx 原语只接收传入事务，回调内不再入队（M1 铁律）。

import type { DbTx } from "../../db.js";

/** 应用层深度护栏：移动/重写后最深层级不得超过 32（护栏而非功能承诺）。 */
export const NAV_MAX_DEPTH = 32;

interface NavPathRow {
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

/** candidatePath 是否为 ancestorPath 自身或其后代（前缀判定）。 */
export function isSelfOrDescendant(ancestorPath: string, candidatePath: string): boolean {
  return candidatePath === ancestorPath || candidatePath.startsWith(ancestorPath);
}

/** 移动防环：新父是被移动节点自身或其子孙则成环；newParentPath=null（移到根）永不环。 */
export function wouldCreateCycle(selfPathValue: string, newParentPath: string | null): boolean {
  if (newParentPath === null || newParentPath === "") return false;
  return isSelfOrDescendant(selfPathValue, newParentPath);
}

/** 子树单行 path 重写公式：保留相对被移动节点的后缀，接到新自身路径之后。 */
export function rewriteSubtreePath(oldPath: string, oldSelfPath: string, newSelfPath: string): string {
  return newSelfPath + oldPath.slice(oldSelfPath.length);
}

export interface SubtreeRewrite {
  id: string;
  newPath: string;
  newDepth: number;
}

/**
 * 计算整棵子树（含自身）移动后的 path/depth 变更集，并做深度护栏校验。纯函数。
 * 按 path 排序保证父在子前。
 */
export function planSubtreeRewrite(
  subtreeInput: NavPathRow[],
  oldSelfPath: string,
  newSelfPath: string,
): SubtreeRewrite[] {
  const subtree = [...subtreeInput].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const updates: SubtreeRewrite[] = [];
  let maxDepth = 0;
  for (const row of subtree) {
    const next = rewriteSubtreePath(row.path, oldSelfPath, newSelfPath);
    const depth = depthOfPath(next);
    maxDepth = Math.max(maxDepth, depth);
    updates.push({ id: row.id, newPath: next, newDepth: depth });
  }
  if (maxDepth > NAV_MAX_DEPTH) {
    throw new Error(`导航层级不能超过 ${NAV_MAX_DEPTH} 层`);
  }
  return updates;
}

/** 事务内逐行应用 path/depth 变更（参数化 update）。 */
export async function applySubtreeRewriteTx(tx: DbTx, updates: SubtreeRewrite[]): Promise<void> {
  for (const u of updates) {
    await tx.navNode.update({ where: { id: u.id }, data: { path: u.newPath, depth: u.newDepth } });
  }
}

interface RebuildNodeRow {
  id: string;
  parentId: string | null;
}

interface PathRebuild {
  id: string;
  path: string;
  depth: number;
}

/**
 * 全量重建 path/depth（纯计算，供回填后首跑与 reconcile --apply 复用）。
 * 入参为全部活节点 (id,parentId)；自引用/断链/环的异常父按根处理（不抛错，差异由 reconcile B/C 类报告）。
 * 实现为反复向上溯源并记忆，O(n * 平均深度)；M3 组织规模子树极小，S10 再证 10 万节点。
 */
export function computePaths(nodes: RebuildNodeRow[]): Map<string, PathRebuild> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const result = new Map<string, PathRebuild>();

  const resolve = (id: string, trail: Set<string>): PathRebuild => {
    const cached = result.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    const parentId = node?.parentId ?? null;
    // 断链父/自环：按根处理（reconcile 会报 A3/B1）。
    if (!parentId || !byId.has(parentId) || parentId === id || trail.has(parentId)) {
      const root: PathRebuild = { id, path: `/${id}/`, depth: 1 };
      result.set(id, root);
      return root;
    }
    const nextTrail = new Set(trail);
    nextTrail.add(id);
    const parent = resolve(parentId, nextTrail);
    const path = `${parent.path}${id}/`;
    const row: PathRebuild = { id, path, depth: parent.depth + 1 };
    result.set(id, row);
    return row;
  };

  for (const n of nodes) resolve(n.id, new Set<string>());
  return result;
}
