// M3/S5 菜单引用树读（GET /api/v1/workspaces/current/menu 的领域服务）。
//
// 返回全部活菜单项（平铺 + parentId，容器嵌套上限 2 层）；shortcut 附节点摘要：
//   - alive：节点行存在且未软删；
//   - soft_dangling：节点行存在但 deletedAt 非空（裁决 6 正常悬挂态，shortcut 保留）；
//   - broken：节点行物理消失（FK RESTRICT 下只可能由关 FK 的异常操作产生）。
// state 对所有登录用户同值——本服务不做任何资源权限判断（M3 零剪枝，裁决 1）。

import type {
  MenuItemDTO, MenuNodeSummaryDTO, MenuTreeDTO, NavKind, ShortcutState,
} from "@gx/shared-types";
import type { DbTx } from "../../db.js";
import { WS_ID } from "./backfill.js";

interface MenuRow {
  id: string; workspaceId: string; parentId: string | null; type: string;
  nodeId: string | null; label: string | null; iconName: string | null; ord: number;
  createdAt: Date; updatedAt: Date | null; deletedAt: Date | null;
}

interface NodeRow {
  id: string; kind: string; name: string; iconName: string | null;
  resourceType: string | null; resourceId: string | null; deletedAt: Date | null;
}

/** 节点行 -> shortcut 摘要（state 由 deletedAt 决定）。 */
function summaryOf(node: NodeRow, state: ShortcutState): MenuNodeSummaryDTO {
  return {
    id: node.id,
    kind: state === "broken" ? null : (node.kind as NavKind),
    name: state === "broken" ? "" : node.name,
    iconName: state === "broken" ? null : node.iconName,
    resourceType: state === "broken" ? null : node.resourceType,
    resourceId: state === "broken" ? null : node.resourceId,
    state,
  };
}

function brokenSummary(nodeId: string): MenuNodeSummaryDTO {
  return {
    id: nodeId, kind: null, name: "", iconName: null,
    resourceType: null, resourceId: null, state: "broken",
  };
}

function toDto(row: MenuRow, node: MenuNodeSummaryDTO | null): MenuItemDTO {
  return {
    id: row.id, parentId: row.parentId, type: row.type as MenuItemDTO["type"],
    nodeId: row.nodeId, label: row.label, iconName: row.iconName, ord: row.ord,
    node, createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/** 解析 shortcut 节点摘要：一次批量取节点后内存映射，broken 逐条补点查。 */
async function resolveShortcuts(tx: DbTx, menus: MenuRow[]): Promise<Map<string, MenuNodeSummaryDTO>> {
  const shortcuts = menus.filter((m) => m.type === "shortcut" && m.nodeId);
  const nodeIds = [...new Set(shortcuts.map((m) => m.nodeId!))];
  const nodes = nodeIds.length
    ? await tx.navNode.findMany({ where: { id: { in: nodeIds } } })
    : [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const result = new Map<string, MenuNodeSummaryDTO>();
  for (const m of shortcuts) {
    const node = byId.get(m.nodeId!);
    if (!node) {
      result.set(m.id, brokenSummary(m.nodeId!));
    } else {
      result.set(m.id, summaryOf(node, node.deletedAt ? "soft_dangling" : "alive"));
    }
  }
  return result;
}

export async function menuVersionOf(tx: DbTx): Promise<number> {
  const ws = await tx.workspace.findUnique({ where: { id: WS_ID }, select: { menuVersion: true } });
  return ws?.menuVersion ?? 0;
}

/** menu 读：全部活菜单项 + shortcut 解析摘要（零剪枝、零分页，容器量天然有界）。 */
export async function readMenuTree(tx: DbTx): Promise<MenuTreeDTO> {
  const menus = await tx.menuItem.findMany({
    where: { workspaceId: WS_ID, deletedAt: null },
    orderBy: [{ ord: "asc" }, { id: "asc" }],
  });
  const summaries = await resolveShortcuts(tx, menus);
  const items = menus.map((m) =>
    toDto(m, m.type === "shortcut" && m.nodeId ? (summaries.get(m.id) ?? brokenSummary(m.nodeId)) : null));
  return { workspaceId: WS_ID, menuVersion: await menuVersionOf(tx), items };
}
