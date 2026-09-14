// M3/S6 权威节点移动：move-impact 预览 + move 执行（计划 §4.5 N6）。
//
// 仅"移动到其他分组"改 nav_nodes.parentId：移动实体节点到活 group（编排覆盖），
// 或移动 group 到 group/根。目标不能是实体节点；防环（新父不能是自身/子孙）；
// 深度护栏 32；执行后整棵子树 path/depth 重写（复用 tree.ts planSubtreeRewrite），
// bump navVersion。M3 口径 = 旧 members/kb_members 可见性（M4 升级三源并集，hint 恒 false）。

import type { MoveImpactDTO } from "@gx/shared-types";
import type { DbTx } from "../../db.js";
import { HttpError } from "../../guards.js";
import { planSubtreeRewrite, applySubtreeRewriteTx, wouldCreateCycle } from "./tree.js";
import { bumpNavVersionTx } from "./sync.js";

interface NodeForMove {
  id: string; parentId: string | null; kind: string; path: string; depth: number;
  resourceType: string | null; resourceId: string | null; deletedAt: Date | null;
}

/** 沿 parentId DFS 收集子树全部活节点（含自身）。 */
function collectSubtree(root: NodeForMove, rows: NodeForMove[]): NodeForMove[] {
  const childrenOf = new Map<string, NodeForMove[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    const arr = childrenOf.get(r.parentId) ?? [];
    arr.push(r);
    childrenOf.set(r.parentId, arr);
  }
  const out: NodeForMove[] = [root];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ch of childrenOf.get(cur.id) ?? []) {
      out.push(ch);
      stack.push(ch);
    }
  }
  return out;
}

const CONTENT_KINDS = new Set(["table", "doc", "canvas"]);

/** 按旧 members/kb_members 口径求子树内容涉及的去重成员数。 */
async function affectedUsersTx(tx: DbTx, subtree: NodeForMove[]): Promise<number> {
  const userIds = new Set<string>();
  const tableIds = subtree.filter((n) => n.kind === "table" && n.resourceId).map((n) => n.resourceId!);
  const docIds = subtree.filter((n) => (n.kind === "doc" || n.kind === "canvas") && n.resourceId).map((n) => n.resourceId!);
  // table -> baseId -> members（members 持 baseId，不是 tableId）。
  if (tableIds.length) {
    const tables = await tx.table.findMany({ where: { id: { in: tableIds } }, select: { baseId: true } });
    const baseIds = [...new Set(tables.map((t) => t.baseId))];
    if (baseIds.length) {
      const rows = await tx.member.findMany({ where: { baseId: { in: baseIds } }, select: { userId: true } });
      rows.forEach((r) => userIds.add(r.userId));
    }
  }
  // doc/canvas -> kbId -> kb_members。
  if (docIds.length) {
    const docs = await tx.kbDoc.findMany({ where: { id: { in: docIds } }, select: { kbId: true } });
    const kbIds = [...new Set(docs.map((d) => d.kbId))];
    if (kbIds.length) {
      const rows = await tx.kbMember.findMany({ where: { kbId: { in: kbIds } }, select: { userId: true } });
      rows.forEach((r) => userIds.add(r.userId));
    }
  }
  return userIds.size;
}

/** 移动前置校验，返回活节点行与新父行（newParentId=null 表示根层）。 */
async function resolveMoveTargets(
  tx: DbTx, nodeIdValue: string, newParentId: string | null,
): Promise<{ node: NodeForMove; target: NodeForMove | null }> {
  const node = await tx.navNode.findFirst({ where: { id: nodeIdValue, deletedAt: null } });
  if (!node) throw new HttpError(404, "节点不存在或已软删");
  let target: NodeForMove | null = null;
  if (newParentId !== null) {
    target = await tx.navNode.findFirst({ where: { id: newParentId, deletedAt: null } });
    if (!target) throw new HttpError(400, "newParentId 对应活节点不存在");
    // 实体节点不能作为编排父：只允许挂 group（view 也不能做父）。
    if (target.kind !== "group") {
      throw new HttpError(400, "节点只能移动到分组（group）下或根层");
    }
  }
  // 实体节点只能移入分组；只有 group 允许移到根层（null）。
  if (newParentId === null && node.kind !== "group") {
    throw new HttpError(400, "实体节点不能移到根层，只能移动到分组下");
  }
  if (newParentId === node.parentId) {
    throw new HttpError(400, "节点已在目标父下，无需移动");
  }
  if (wouldCreateCycle(node.path, target?.path ?? null)) {
    throw new HttpError(400, "不能把节点移动到自身或其子孙下", "NAV_CYCLE");
  }
  return { node: node as unknown as NodeForMove, target: target as unknown as NodeForMove | null };
}

/** 预览影响：受影响成员数（旧口径去重）、子树内容数、菜单引用数。 */
export async function moveImpactTx(
  tx: DbTx, nodeIdValue: string, newParentId: string | null,
): Promise<MoveImpactDTO> {
  const { node, target } = await resolveMoveTargets(tx, nodeIdValue, newParentId);
  void target;
  const rows = (await tx.navNode.findMany({ where: { deletedAt: null } })) as unknown as NodeForMove[];
  const subtree = collectSubtree(node, rows);
  const contentNodes = subtree.filter((n) => CONTENT_KINDS.has(n.kind));
  const subtreeIds = new Set(subtree.map((n) => n.id));
  const shortcuts = await tx.menuItem.findMany({ where: { deletedAt: null, type: "shortcut" }, select: { nodeId: true } });
  const shortcutCount = shortcuts.filter((s) => s.nodeId && subtreeIds.has(s.nodeId)).length;
  const affectedUserCount = await affectedUsersTx(tx, subtree);
  return {
    nodeId: nodeIdValue,
    newParentId: newParentId ?? "",
    subtreeItemCount: contentNodes.length,
    affectedUserCount,
    shortcutCount,
    willBreakInheritanceHint: false,
  };
}

/** 执行移动：改 parentId + 子树 path/depth 重写 + bump navVersion。 */
export async function moveNodeTx(
  tx: DbTx, nodeIdValue: string, newParentId: string | null,
): Promise<void> {
  const { node, target } = await resolveMoveTargets(tx, nodeIdValue, newParentId);
  const rows = (await tx.navNode.findMany({ where: { deletedAt: null } })) as unknown as NodeForMove[];
  const subtree = collectSubtree(node, rows);
  const newSelfPath = newParentId === null
    ? `/${node.id}/`
    : `${target!.path}${node.id}/`;
  const updates = planSubtreeRewrite(
    subtree.map((n) => ({ id: n.id, parentId: n.parentId, path: n.path })),
    node.path,
    newSelfPath,
  );
  await tx.navNode.update({ where: { id: nodeIdValue }, data: { parentId: newParentId } });
  await applySubtreeRewriteTx(tx, updates);
  await bumpNavVersionTx(tx);
}
