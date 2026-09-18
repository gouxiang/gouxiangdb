// 阶段 1 壳层：由当前路由反推 L2 应展示的容器（R-N-02「刷新后必须完整还原」）。
//
// 骨架 S-1 要求 L2 常驻，而 L2 的内容由「当前库容器」决定。URL 形状是
// /base/:baseId/... 与 /kb/:kbId/...（N5：旧形永不改名），故先按 resourceType:resourceId
// 在权威树索引里找回 nav 节点，再在菜单引用树里找回引用它的 container 项。
//
// 纯函数：不碰 react-router / react-query，便于 SSR 单测直接值断言。

import type { MenuItemDTO } from "@gx/shared-types";
import type { NodeIndex } from "./nav-links";

/** 沿菜单 parentId 上溯最近的 container（防御父环：已访问集合 + 32 层护栏）。 */
export function nearestContainerItem(
  items: readonly MenuItemDTO[],
  startParentId: string | null,
): MenuItemDTO | null {
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  let cursor: string | null = startParentId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const item: MenuItemDTO | undefined = byId.get(cursor);
    if (!item) return null;
    if (item.type === "container") return item;
    cursor = item.parentId;
    if (seen.size > 32) return null;
  }
  return null;
}

/**
 * 给定权威节点 id，找出应为它展开 L2 的 container 菜单项。
 * 两条路径：① 有 container 直接引用该节点（库首页 / 库设置）；
 *          ② 只有 shortcut 引用（表 / 文档 / 画布）→ 上溯到最近的 container。
 * 都找不到返回 null：调用方据此把 L2 宽度归零（不占位），不另写一套壳。
 */
export function resolveContainerItem(
  items: readonly MenuItemDTO[],
  nodeId: string | null | undefined,
): MenuItemDTO | null {
  if (!nodeId) return null;
  const direct = items.find((i) => i.type === "container" && i.nodeId === nodeId);
  if (direct) return direct;
  const shortcut = items.find((i) => i.type === "shortcut" && i.nodeId === nodeId);
  if (!shortcut) return null;
  return nearestContainerItem(items, shortcut.parentId);
}

/**
 * 当前路由作用域（base / kb）→ L2 容器。
 * 返回 null 表示「这类入口没有二级内容」，L2 应收起；undefined 表示数据未就绪。
 */
export function resolveRouteContainer(
  items: readonly MenuItemDTO[],
  index: NodeIndex,
  scope: { kind: "base" | "kb"; id: string } | null,
): MenuItemDTO | null {
  if (!scope) return null;
  const node = index.byResource.get(`${scope.kind}:${scope.id}`);
  if (!node) return null;
  return resolveContainerItem(items, node.id);
}
