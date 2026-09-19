// L1 菜单精细化：树 → 「分组标题 + 平铺菜单项」两层行序列（UI-SPEC R-N-01 参考形态）。
//
// 与 lib/menu-tree.ts 的分工：
//   - menu-tree.flattenMenuRows 是**编排态**用的深递归摊平（容器可折叠，就地缩进展开）；
//     本模块是**浏览态**用的两层摊平：container 一律降级为分组标题行，其 shortcut 子项
//     平铺在下方，不再有展开/收起交互（用户点名要去掉的手风琴）。
//   - 更深层级（container 下还有 container）不再就地展开，而是把子树的子节点交给
//     buildFlyoutRows，由行组件在 hover / 键盘聚焦时向侧方浮出独立面板。
//
// 纯函数、无 DOM、无 React，可直接 vitest。
import type { MenuTreeNode } from "./menu-tree";

/** 菜单项行高（参考图实测 32）。 */
export const NAV_ITEM_ROW_H = 32;
/** 分组标题行高（比菜单项更紧凑，参考图小节标题）。 */
export const NAV_GROUP_ROW_H = 24;
/** 行距：每行下方 2px，计入窗口化行高（否则窗口化的 padTop/padBottom 会累积漂移）。 */
export const NAV_ROW_GAP = 2;

/** 一层平铺行：分组标题 或 菜单项（nested 非空表示带侧方浮出子菜单）。 */
export type NavSectionRow =
  | { kind: "group"; id: string; node: MenuTreeNode }
  | { kind: "item"; id: string; node: MenuTreeNode; nested: readonly MenuTreeNode[] };

/**
 * 把菜单树摊成「分组标题 + 平铺子项」两层。
 * - 根级 container → 分组标题行 + 直接子项行（不再递归缩进展开）；
 * - 根级 shortcut → 直接是菜单项行（与分组标题同级，不缩进）；
 * - 子项是 container（更深层级）→ 仍占一个菜单项行，子树挂到 nested 由浮出面板承载。
 */
export function flattenMenuSections(nodes: readonly MenuTreeNode[]): NavSectionRow[] {
  const rows: NavSectionRow[] = [];
  for (const node of nodes) {
    if (node.item.type !== "container") {
      rows.push({ kind: "item", id: node.item.id, node, nested: [] });
      continue;
    }
    rows.push({ kind: "group", id: node.item.id, node });
    for (const child of node.children) {
      rows.push({
        kind: "item",
        id: child.item.id,
        node: child,
        nested: child.item.type === "container" ? child.children : [],
      });
    }
  }
  return rows;
}

/** 行序列 → 窗口化需要的逐行占位高度（行高 + 行距）。 */
export function navRowHeights(rows: readonly NavSectionRow[]): number[] {
  return rows.map((r) => (r.kind === "group" ? NAV_GROUP_ROW_H : NAV_ITEM_ROW_H) + NAV_ROW_GAP);
}

/** 浮出面板内的一行：一级标题（子容器）或二级子项。 */
export interface FlyoutRow {
  kind: "title" | "item";
  id: string;
  node: MenuTreeNode;
  /** 缩进档（0 = 面板一级，1+ = 其下属层级）。 */
  depth: number;
}

/** 浮出面板内最多展示三层缩进（面板再深只会更难点，后端容器本身限两层）。 */
const FLYOUT_MAX_DEPTH = 2;

/**
 * 深层子树的浮出行：子容器渲染为「一级标题」，其子节点降一级缩进。
 * 递归但不无限：depth > FLYOUT_MAX_DEPTH 的子树不再展开（真实数据到不了这一层）。
 */
export function buildFlyoutRows(
  children: readonly MenuTreeNode[],
  depth = 0,
): FlyoutRow[] {
  const rows: FlyoutRow[] = [];
  for (const node of children) {
    if (node.item.type === "container") {
      rows.push({ kind: "title", id: node.item.id, node, depth });
      if (depth < FLYOUT_MAX_DEPTH) rows.push(...buildFlyoutRows(node.children, depth + 1));
      continue;
    }
    rows.push({ kind: "item", id: node.item.id, node, depth });
  }
  return rows;
}
