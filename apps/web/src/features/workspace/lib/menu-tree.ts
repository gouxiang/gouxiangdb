// M3 统一导航：菜单树纯函数（平铺 menu items → 树 / 激活态定位 / 悬挂过滤）。
// 无 DOM、无 React，S8/S9 共用，单测见 menu-tree.test.ts。
//
// 与 contacts/lib/tree.ts 的分工：那棵是部门树（parentId 真相 + 软删 + 环防御）；
// 本模块只处理 menu_items 引用层（container/shortcut 两类，深度后端限 2 层容器）。

import type { MenuItemDTO, MenuTreeDTO, ShortcutState } from "@gx/shared-types";

/** 组装后的菜单树节点（容器或快捷项）。 */
export interface MenuTreeNode {
  item: MenuItemDTO;
  children: MenuTreeNode[];
}

function itemSorter(a: MenuItemDTO, b: MenuItemDTO): number {
  if (a.ord !== b.ord) return a.ord - b.ord;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 平铺菜单项组树（parentId 真相）。
 * 容错：parentId 指向的父项缺失时按根项挂出（后端 RESTRICT 约束下不应发生，
 * 此处仅保证 UI 不因脏数据整树白屏）。
 */
export function buildMenuTree(items: readonly MenuItemDTO[]): MenuTreeNode[] {
  const byId = new Map<string, MenuTreeNode>();
  for (const item of items) byId.set(item.id, { item, children: [] });

  const roots: MenuTreeNode[] = [];
  for (const node of byId.values()) {
    const pid = node.item.parentId;
    const parent = pid ? byId.get(pid) : undefined;
    if (parent && parent.item.id !== node.item.id) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (nodes: MenuTreeNode[]) => {
    nodes.sort((a, b) => itemSorter(a.item, b.item));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/**
 * 浏览态可见性规则（ADR-0029 / openapi state 三态，M3 写死前端规则）：
 *  - alive：正常显示；
 *  - soft_dangling：全员隐藏（实体软删，shortcut 保留待恢复自动还原，非阻断）；
 *  - broken：普通浏览隐藏，仅编排态显灰可清理（由 composerVisible 单独放行）；
 *  - node 摘要缺失（container 无 node 是正常态；shortcut node=null 视为 broken）。
 */
export function isBrowsableShortcut(item: MenuItemDTO): boolean {
  if (item.type !== "shortcut") return true;
  const state: ShortcutState | undefined = item.node?.state;
  return state === "alive";
}

/** 编排态可见：alive/soft_dangling/broken 全保留（soft_dangling/broken 由 UI 标灰）。 */
export function isComposerVisible(item: MenuItemDTO): boolean {
  if (item.type === "container") return true;
  return item.node !== null;
}

/** 仅保留浏览态可显示的菜单项（容器在过滤掉全部子项后是否保留由调用方决定）。 */
export function filterBrowsableItems(items: readonly MenuItemDTO[]): MenuItemDTO[] {
  return items.filter(isBrowsableShortcut);
}

/**
 * 激活态定位：给定当前内容路径对应的资源 id（tableId/docId/canvasId/baseId/kbId），
 * 返回指向该 nav 节点的全部活 shortcut 菜单项（允许同一实体多处挂载 → 多处高亮）。
 * 需要 node.resourceId 匹配；state 非 alive 的不参与激活。
 */
export function findActiveShortcuts(menu: MenuTreeDTO | undefined, resourceId: string | null | undefined): MenuItemDTO[] {
  if (!menu || !resourceId) return [];
  return menu.items.filter(
    (i) => i.type === "shortcut" && i.node?.state === "alive" && i.node.resourceId === resourceId,
  );
}

/** 活 shortcut 指向的实体若位于某容器子树，返回该一级容器 id（一级快捷项返回 null）。 */
export function primaryContainerOf(item: MenuItemDTO): string | null {
  return item.parentId;
}

/** 统计某容器子树内浏览态可见的活 shortcut 数（空容器灰显用）。 */
export function visibleShortcutCount(nodes: readonly MenuTreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.item.type === "shortcut" && isBrowsableShortcut(node.item)) n++;
    n += visibleShortcutCount(node.children);
  }
  return n;
}
