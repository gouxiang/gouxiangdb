// 阶段 1 壳层（第三批改写）：由当前路由反推 L2 应展示的容器（R-N-02「刷新后必须完整还原」）。
//
// 口径变化：L1 / L2 都不再依赖 menu_items 引用树。
//   - 老的 resolveContainerItem / resolveRouteContainer 是「在 menu 树里找回引用它的 container」，
//     随导航编排一并下线（源码与调用点都已不存在）；
//   - 新的 deriveScopeContainer 直接由 URL 的 base/kb id 在实体列表里取容器本体，
//     id 命中列表即展开 L2，名字也取自同一份列表（单一真源，不会与列表不一致）。
//
// 纯函数：不碰 react-router / react-query，便于 SSR 单测直接值断言。

/** 实体列表所需的最小形态（BaseDTO / KbDTO 都结构化满足）。 */
export interface ScopedLibrary {
  id: string;
  name: string;
}

/** 一级选中的容器（即二级要展示其子项的库）。 */
export interface ScopeContainer {
  kind: "base" | "kb";
  id: string;
  name: string;
}

/**
 * 路由作用域 → L2 容器。
 * 返回 null 的三种情形（调用方据此把 L2 收起为 0 宽、不占位）：
 *   ① 不在任何 base/kb 路由下（工作区级页面）；
 *   ② 列表未就绪（数据还在路上）——此时也先不渲染，避免面板头先闪一个错名；
 *   ③ id 不在列表里（无权限访问 / 已删除）。
 */
export function deriveScopeContainer(
  bases: readonly ScopedLibrary[] | null | undefined,
  kbs: readonly ScopedLibrary[] | null | undefined,
  scope: { kind: "base" | "kb"; id: string } | null,
): ScopeContainer | null {
  if (!scope) return null;
  const list = scope.kind === "base" ? bases : kbs;
  if (!list) return null;
  const hit = list.find((e) => e.id === scope.id);
  if (!hit) return null;
  return { kind: scope.kind, id: hit.id, name: hit.name };
}
