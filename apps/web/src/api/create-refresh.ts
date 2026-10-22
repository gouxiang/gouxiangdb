// apps/web/src/api/create-refresh.ts
// 建库 / 建表成功后、navigate 到新资源**真实路由**之前，必须 await 的缓存刷新。
//
// 背景（与 #1006 删表跳转同竞态类）：mutation 的 onSuccess 此前只「触发」缓存失效
// （void qc.invalidateQueries），mutateAsync 立刻 resolve，调用方在 .then 里马上
// navigate。此时目标路由挂载的重定向组件读到的还是失效前的旧/空缓存：
//   - 建库后跳 /base/:newId：BaseIndexRedirect 的 useTables/根索引 useBases 尚未就位，
//     可能闪错或被误导向旧库 / 设置页；
//   - 建表后跳 /base/:id/table/:newId：TableIndexRedirect 的 useViews 若拿到空占位会
//     被误判成「该表无视图」而重定向到设置页。
// await 后调用方跳转时关键列表必为新数据（TanStack 对挂载中的观察者会 refetch 并等其落地）。
//
// 抽成无 React 纯函数（只吃 QueryClient），便于 node 环境用真实 QueryClient + QueryObserver
// 做行为级单测，不必引入 jsdom / renderHook。

import type { QueryClient } from "@tanstack/react-query";

/**
 * 建库成功后必须先落地的刷新：库列表 ["bases"]（根索引 / 导航据此决定跳去哪一个库）。
 * 与具体库相关的表 / 回收站等维度不阻塞跳转，由调用方按需延迟失效。
 */
export async function refreshAfterCreateBase(qc: QueryClient): Promise<void> {
  await qc.invalidateQueries({ queryKey: ["bases"] });
}

/**
 * 建表成功后必须先落地的刷新：
 *   - ["tables", baseId]：库下表面板 / BaseIndexRedirect 立刻能看到新表；
 *   - ["views", tableId] / ["fields", tableId]：TableIndexRedirect 读 views 决定跳第一个视图。
 *     新表此刻通常还没有挂载观察者（导航后才挂载并 fresh fetch → 显示 Loading），
 *     await 失效仍能清掉任何可能的旧/空占位，杜绝「空视图 → 误跳设置页」。
 */
export async function refreshAfterCreateTable(
  qc: QueryClient,
  baseId: string,
  tableId: string,
): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["tables", baseId] }),
    qc.invalidateQueries({ queryKey: ["views", tableId] }),
    qc.invalidateQueries({ queryKey: ["fields", tableId] }),
  ]);
}
