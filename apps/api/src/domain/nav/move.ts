// M3/S6 权威节点移动：move-impact 预览 + move 执行（计划 §4.5 N6，M4/S7 升三源口径）。
//
// 仅"移动到其他分组"改 nav_nodes.parentId：移动实体节点到活 group（编排覆盖），
// 或移动 group 到 group/根。目标不能是实体节点；防环（新父不能是自身/子孙）；
// 深度护栏 32；执行后整棵子树 path/depth 重写（复用 tree.ts planSubtreeRewrite），
// bump navVersion。
//
// M4/S7 影响口径升级（裁决 A-7：人数不含行级谓词）：
//   affectedUserCount = 对子树内每个资源节点分别求移动前/后 r 可见用户集（三源 direct/dept/role
//   展开 + ACTIVE 收敛 + creator/workspace owner 兜底），任一资源节点两侧对称差命中的用户并集
//   去重计数（与逐节点 decide/scope 可对拍 0 差异）；
//   willBreakInheritanceHint = 子树某资源节点最近 inheritAncestors=0 祖先移动前后不同。

import type { MoveImpactDTO } from "@gx/shared-types";
import type { DbTx } from "../../db.js";
import { HttpError } from "../../guards.js";
import { planSubtreeRewrite, applySubtreeRewriteTx, wouldCreateCycle } from "./tree.js";
import { bumpNavVersionTx } from "./sync.js";
import { GrantExpander, workspaceOwnerIds, type GrantRef } from "../authz/impactExpand.js";
import { hypotheticalCollectIds } from "../authz/inheritance.js";
import { makeCreatedByResolver } from "../authz/adapter.js";
import type { AuthzClient, AuthzNode } from "../authz/types.js";

interface NodeForMove {
  id: string; parentId: string | null; kind: string; path: string; depth: number;
  resourceType: string | null; resourceId: string | null; deletedAt: Date | null;
  inheritAncestors: number; workspaceId: string;
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

/** 叶->根序祖先链（由物化路径切段 + byId 还原）。 */
function chainOfPath(path: string, byId: ReadonlyMap<string, NodeForMove>): NodeForMove[] {
  const ids = path.split("/").filter(Boolean).reverse();
  const out: NodeForMove[] = [];
  for (const id of ids) {
    const n = byId.get(id);
    if (n) out.push(n);
  }
  return out;
}

/** 链（叶->根，含自身）上最近的 inheritAncestors=0 祖先（不含自身）；无则 null。 */
function nearestRestrictedAncestor(chain: readonly NodeForMove[]): string | null {
  for (let i = 1; i < chain.length; i++) {
    if (chain[i]!.inheritAncestors === 0) return chain[i]!.id;
  }
  return null;
}

type GrantRow = { nodeId: string; subjectType: "user" | "dept" | "role"; subjectId: string };

/** 读一批节点上的含 r 授予（三源行；动作内存判定）。 */
async function readReadGrants(client: AuthzClient, nodeIds: ReadonlySet<string>): Promise<GrantRow[]> {
  if (nodeIds.size === 0) return [];
  const rows = await client.authPolicy.findMany({
    where: { nodeId: { in: [...nodeIds] } },
    select: { nodeId: true, subjectType: true, subjectId: true, actions: true },
  });
  const out: GrantRow[] = [];
  for (const r of rows) {
    if (!r.actions.split(",").map((s) => s.trim()).includes("r")) continue;
    if (r.subjectType === "user" || r.subjectType === "dept" || r.subjectType === "role") {
      out.push({ nodeId: r.nodeId, subjectType: r.subjectType, subjectId: r.subjectId });
    }
  }
  return out;
}

/** 单资源节点一侧（before/after）的 ACTIVE 可见用户集（含 creator/workspace owner 兜底）。 */
async function visibleUsersForSide(
  client: AuthzClient,
  expander: GrantExpander,
  grantsByNode: ReadonlyMap<string, GrantRow[]>,
  cutoffIds: readonly string[],
  creatorId: string | null,
  ownerIds: ReadonlySet<string>,
): Promise<Set<string>> {
  const grants: GrantRef[] = [];
  for (const cid of cutoffIds) {
    for (const g of grantsByNode.get(cid) ?? []) grants.push(g);
  }
  const sources = await expander.expand(grants);
  if (creatorId) sources.set(creatorId, new Set([`creator:${cutoffIds[0]}`]));
  for (const o of ownerIds) sources.set(o, new Set(["owner:workspace"]));
  return expander.activeOnly(new Set(sources.keys()));
}

/** 三源可见集逐资源节点对称差人数 + restricted 边界变化 hint。 */
async function computeAuthzImpact(
  tx: DbTx,
  rows: readonly NodeForMove[],
  node: NodeForMove,
  target: NodeForMove | null,
): Promise<{ affectedUserCount: number; willBreakInheritanceHint: boolean }> {
  const subtree = collectSubtree(node, rows as NodeForMove[]);
  const newSelfPath = target === null ? `/${node.id}/` : `${target.path}${node.id}/`;
  const updates = planSubtreeRewrite(
    subtree.map((n) => ({ id: n.id, parentId: n.parentId, path: n.path })),
    node.path,
    newSelfPath,
  );
  const newPaths = new Map(updates.map((u) => [u.id, u.newPath]));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const contentNodes = subtree.filter((n) => n.resourceType !== null);
  // 收集两侧所有 cutoff 节点，批量一次读授予。
  const cutoffPool = new Set<string>();
  const sides = contentNodes.map((n) => {
    const beforeChain = chainOfPath(n.path, byId) as unknown as AuthzNode[];
    const afterChain = chainOfPath(newPaths.get(n.id) ?? n.path, byId) as unknown as AuthzNode[];
    const beforeIds = hypotheticalCollectIds(beforeChain, n.inheritAncestors === 1 ? 1 : 0);
    const afterIds = hypotheticalCollectIds(afterChain, n.inheritAncestors === 1 ? 1 : 0);
    for (const id of beforeIds) cutoffPool.add(id);
    for (const id of afterIds) cutoffPool.add(id);
    return { n, beforeIds, afterIds, beforeChain, afterChain };
  });
  const grantRows = await readReadGrants(tx, cutoffPool);
  const grantsByNode = new Map<string, GrantRow[]>();
  for (const g of grantRows) {
    const list = grantsByNode.get(g.nodeId) ?? [];
    list.push(g);
    grantsByNode.set(g.nodeId, list);
  }

  const expander = new GrantExpander(tx);
  const resolveCreatedBy = makeCreatedByResolver(tx);
  const ownerIds = await workspaceOwnerIds(tx);
  const affected = new Set<string>();
  for (const side of sides) {
    const creator = await resolveCreatedBy(side.n as unknown as AuthzNode);
    const [before, after] = await Promise.all([
      visibleUsersForSide(tx, expander, grantsByNode, side.beforeIds, creator, ownerIds),
      visibleUsersForSide(tx, expander, grantsByNode, side.afterIds, creator, ownerIds),
    ]);
    for (const id of before) if (!after.has(id)) affected.add(id);
    for (const id of after) if (!before.has(id)) affected.add(id);
  }

  let hint = false;
  for (const side of sides) {
    if (nearestRestrictedAncestor(side.beforeChain as unknown as NodeForMove[])
      !== nearestRestrictedAncestor(side.afterChain as unknown as NodeForMove[])) {
      hint = true;
      break;
    }
  }
  return { affectedUserCount: affected.size, willBreakInheritanceHint: hint };
}

/** 预览影响：受影响成员数（M4 三源逐节点对称差）、子树内容数、菜单引用数、继承边界 hint。 */
export async function moveImpactTx(
  tx: DbTx, nodeIdValue: string, newParentId: string | null,
): Promise<MoveImpactDTO> {
  const { node, target } = await resolveMoveTargets(tx, nodeIdValue, newParentId);
  const rows = (await tx.navNode.findMany({ where: { deletedAt: null } })) as unknown as NodeForMove[];
  const subtree = collectSubtree(node, rows);
  const contentNodes = subtree.filter((n) => CONTENT_KINDS.has(n.kind));
  const subtreeIds = new Set(subtree.map((n) => n.id));
  const shortcuts = await tx.menuItem.findMany({ where: { deletedAt: null, type: "shortcut" }, select: { nodeId: true } });
  const shortcutCount = shortcuts.filter((s) => s.nodeId && subtreeIds.has(s.nodeId)).length;
  const { affectedUserCount, willBreakInheritanceHint } = await computeAuthzImpact(tx, rows, node, target);
  return {
    nodeId: nodeIdValue,
    newParentId: newParentId ?? "",
    subtreeItemCount: contentNodes.length,
    affectedUserCount,
    shortcutCount,
    willBreakInheritanceHint,
  };
}

/** 执行移动：改 parentId + 子树 path/depth 重写 +（可选）落位 ord + bump navVersion。
 *  ord 仅供 YN8 离线回放（§19.6 nav_move 携带 to(parentId,ord)）；在线路径不传 → ord 原样保留，
 *  与既有行为逐字节一致。ord 必须为整数（非法抛 400），兄弟集合归一化由 reorder 单独负责。 */
export async function moveNodeTx(
  tx: DbTx,
  nodeIdValue: string,
  newParentId: string | null,
  ord?: number,
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
  if (ord !== undefined && (typeof ord !== "number" || !Number.isInteger(ord))) {
    throw new HttpError(400, "移动落位 ord 必须是整数", "NAV_BAD_ORD");
  }
  await tx.navNode.update({
    where: { id: nodeIdValue },
    data: { parentId: newParentId, ...(ord !== undefined ? { ord } : {}) },
  });
  await applySubtreeRewriteTx(tx, updates);
  await bumpNavVersionTx(tx);
}

/**
 * YN8 兄弟集合重排（nav_reorder 回放专用，§19.6「对同一组兄弟排序」）。
 *
 * 权威顺序以 orderedIds（某一父下【全部】活兄弟的有序 id 列表，parentId=null 表根层）为准，
 * 逐行写 ord=下标。强集合一致校验（与 reorderFieldsTx 同口径）：
 *   - 长度相等、无重复、且每个 id 都是该父当前活兄弟 → 任一不满足抛 400（离线期间该组有增删/移动，
 *     让树冲突浮现交人工裁决，绝不按部分列表静默重排导致丢节点序）；
 * 不修改 parentId/path（纯排序）；末尾 bump 旧 int navVersion（treeVersion 由同步层另记）。
 */
export async function reorderNavSiblingsTx(
  tx: DbTx,
  parentId: string | null,
  orderedIds: readonly string[],
): Promise<void> {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new HttpError(400, "nav_reorder 需要非空有序节点 id 列表", "NAV_BAD_REORDER");
  }
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new HttpError(400, "nav_reorder 排序列表含重复节点", "NAV_BAD_REORDER");
  }
  const live = await tx.navNode.findMany({
    where: { parentId, deletedAt: null },
    select: { id: true },
  });
  const liveIds = live.map((x) => x.id);
  const sameSet = liveIds.length === orderedIds.length
    && orderedIds.every((id) => liveIds.includes(id));
  if (!sameSet) {
    throw new HttpError(400, "排序列表与当前同级节点集合不一致（可能离线期间有增删/移动），请刷新后重试", "NAV_BAD_REORDER");
  }
  for (let i = 0; i < orderedIds.length; i += 1) {
    await tx.navNode.update({ where: { id: orderedIds[i] }, data: { ord: i } });
  }
  await bumpNavVersionTx(tx);
}
