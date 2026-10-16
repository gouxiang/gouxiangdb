// M3/S6 分组（nav_nodes kind='group'）域服务：建/改/删。
//
// group 是纯编排客体（isSystem=0、无实体），层级挂在 nav_nodes 树上，与菜单容器
// （menu_items，2 层上限）是两套结构。删除组时组内实体节点必须显式处置：
//   - strategy=move：整组内容迁到 targetParentId 指定的另一个活组；
//   - strategy=retain：实体节点回落实体默认父（table->其 base、view->其 table、
//     doc/canvas->kb/父 doc 树位，默认父集取 buildExpectedNodes），子组顶到被删组父位。
// 组清空后物理删行；仍有活 shortcut 指向组 -> 409 NAV_NODE_IN_USE（FK RESTRICT 亦兜）。

import crypto from "node:crypto";
import type { CreateGroupInput, GroupDeleteStrategy } from "@gx/shared-types";
import type { DbTx } from "../../db.js";
import { HttpError } from "../../guards.js";
import {
  WS_ID, buildExpectedNodes, rebuildPathsTx,
} from "./backfill.js";
import { NAV_MAX_DEPTH } from "./tree.js";
import { bumpNavVersionTx, syncNavFromEntitiesTx } from "./sync.js";

const NAME_MAX = 60;

interface NodeLite {
  id: string; parentId: string | null; kind: string; depth: number;
  resourceType: string | null; resourceId: string | null; deletedAt: Date | null;
}

async function liveNode(tx: DbTx, id: string): Promise<NodeLite | null> {
  return tx.navNode.findFirst({ where: { id, deletedAt: null } });
}

/** 建组：父只能是活 group 或 null；深度护栏 32。 */
export async function createGroupTx(tx: DbTx, input: CreateGroupInput): Promise<string> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > NAME_MAX) throw new HttpError(400, `分组名不能为空且不超过 ${NAME_MAX} 字`);
  const parentId = input.parentId ?? null;
  let parentDepth = 0;
  if (parentId !== null) {
    const parent = await liveNode(tx, parentId);
    if (!parent || parent.kind !== "group") throw new HttpError(400, "分组只能挂在另一个分组下");
    parentDepth = parent.depth;
  }
  if (parentDepth + 1 > NAV_MAX_DEPTH) {
    throw new HttpError(400, `导航层级不能超过 ${NAV_MAX_DEPTH} 层`, "NAV_DEPTH_EXCEEDED");
  }
  const ord = typeof input.ord === "number" && Number.isInteger(input.ord) ? input.ord : 0;
  // YN8：离线回放保留客户端分组 id（§8.4）；在线路径 input.id 恒 undefined → 服务端造 navgrp_ id。
  // 显式 id 只允许 cuid 风格安全字符（会拼进物化路径，禁 '/' 与空白），防止破坏路径/撞系统节点。
  const explicitId = typeof input.id === "string" ? input.id.trim() : "";
  const id = explicitId && /^[A-Za-z0-9_-]{8,64}$/.test(explicitId)
    ? explicitId
    : `navgrp_${crypto.randomBytes(12).toString("hex")}`;
  const parentPath = parentId === null
    ? null
    : (await tx.navNode.findUnique({ where: { id: parentId }, select: { path: true } }))?.path ?? null;
  await tx.navNode.create({
    data: {
      id, workspaceId: WS_ID, parentId, kind: "group", name, ord,
      path: parentPath === null ? `/${id}/` : `${parentPath}${id}/`,
      depth: parentDepth + 1,
      isSystem: 0, inheritAncestors: 1,
      ...(input.iconName ? { iconName: input.iconName } : {}),
    },
  });
  await bumpNavVersionTx(tx);
  return id;
}

/** 改名/排序。 */
export async function updateGroupTx(
  tx: DbTx, id: string, patch: { name?: unknown; ord?: unknown },
): Promise<void> {
  const node = await tx.navNode.findUnique({ where: { id } });
  if (!node || node.deletedAt || node.kind !== "group") {
    throw new HttpError(404, "分组不存在或已删除");
  }
  const data: { name?: string; ord?: number } = {};
  if (patch.name !== undefined) {
    const name = typeof patch.name === "string" ? patch.name.trim() : "";
    if (!name || name.length > NAME_MAX) throw new HttpError(400, `分组名不能为空且不超过 ${NAME_MAX} 字`);
    data.name = name;
  }
  if (patch.ord !== undefined) {
    if (typeof patch.ord !== "number" || !Number.isInteger(patch.ord)) throw new HttpError(400, "ord 必须是整数");
    data.ord = patch.ord;
  }
  if (Object.keys(data).length) {
    await tx.navNode.update({ where: { id }, data });
    await bumpNavVersionTx(tx);
  }
}

/** 收集直接/间接挂在某组下的全部活子节点（沿 parentId DFS）。 */
function collectGroupChildren(groupId: string, rows: NodeLite[]): NodeLite[] {
  const childrenOf = new Map<string, NodeLite[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    const arr = childrenOf.get(r.parentId) ?? [];
    arr.push(r);
    childrenOf.set(r.parentId, arr);
  }
  const out: NodeLite[] = [];
  const stack = [...(childrenOf.get(groupId) ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    for (const ch of childrenOf.get(cur.id) ?? []) stack.push(ch);
  }
  return out;
}

/** 实体默认父映射（id -> 默认 parentId），取实体期望集。 */
async function defaultParentMap(tx: DbTx): Promise<Map<string, string | null>> {
  const expected = await buildExpectedNodes(tx);
  return new Map(expected.map((e) => [e.id, e.parentId]));
}

/**
 * 删组。strategy 缺省且组非空 -> 409 NAV_GROUP_NOT_EMPTY。
 * 空组（无子节点）两策略等价，直接物理删；有活 shortcut 指组 -> 409 NAV_NODE_IN_USE。
 */
export async function deleteGroupTx(
  tx: DbTx,
  id: string,
  strategy: GroupDeleteStrategy | undefined,
  targetParentId: string | null,
): Promise<{ id: string; moved: number }> {
  const group = await tx.navNode.findUnique({ where: { id } });
  if (!group || group.deletedAt || group.kind !== "group") {
    throw new HttpError(404, "分组不存在或已删除");
  }
  const liveRows = (await tx.navNode.findMany({ where: { deletedAt: null } })) as NodeLite[];
  const allChildren = collectGroupChildren(id, liveRows);
  // 只重挂【直接】子节点：嵌套子组的后代随子组一起迁移/上顶，不被拉平。
  const directChildren = liveRows.filter((r) => r.parentId === id);

  const refs = await tx.menuItem.count({ where: { nodeId: id, deletedAt: null } });
  if (refs > 0) throw new HttpError(409, "仍有菜单项引用该分组，请先移除", "NAV_NODE_IN_USE");

  if (allChildren.length > 0 && !strategy) {
    throw new HttpError(409, "分组非空，删除须指定 strategy=move|retain", "NAV_GROUP_NOT_EMPTY");
  }

  if (allChildren.length > 0 && strategy === "move") {
    if (!targetParentId) throw new HttpError(400, "strategy=move 必须带 targetParentId");
    if (targetParentId === id) throw new HttpError(400, "targetParentId 不能是被删分组自身");
    const target = await liveNode(tx, targetParentId);
    if (!target || target.kind !== "group") throw new HttpError(400, "targetParentId 必须是另一个活分组");
    // 目标不能在被删组子树内（否则随删组消失）。
    if (allChildren.some((c) => c.id === targetParentId)) {
      throw new HttpError(400, "targetParentId 不能是被删分组的子孙分组");
    }
    for (const child of directChildren) {
      await tx.navNode.update({ where: { id: child.id }, data: { parentId: targetParentId } });
    }
  } else if (allChildren.length > 0 && strategy === "retain") {
    const defaults = await defaultParentMap(tx);
    for (const child of directChildren) {
      // 直接子组顶到被删组父位；直接实体节点回落实体默认父（table->base、doc->kb/父 doc）。
      const fallback = child.kind === "group" ? group.parentId : (defaults.get(child.id) ?? null);
      await tx.navNode.update({ where: { id: child.id }, data: { parentId: fallback } });
    }
  }

  await tx.navNode.delete({ where: { id } });
  if (allChildren.length > 0) {
    if (strategy === "retain") {
      // 回落实体节点：父/ord/name 全部由实体期望集对齐 + 统一 path 重算 + bump。
      await syncNavFromEntitiesTx(tx);
    } else {
      // move：内容保持编排态，仅重算子树 path 并 bump。
      await rebuildPathsTx(tx);
      await bumpNavVersionTx(tx);
    }
  } else {
    await bumpNavVersionTx(tx);
  }
  return { id, moved: directChildren.length };
}
