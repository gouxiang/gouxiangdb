// apps/web/src/node/useLauncher.ts
// 启动器 UI 订阅启动器仓库的**薄 React 适配层**（DESIGN-MACOS-APP.md §8.5）。
//
// 关键：useSyncExternalStore 的 getSnapshot 必须返回**引用稳定**的值，否则 React 会判
// "getSnapshot 每次都是新对象"而无限重渲。这里只订阅不可变的注册表 state（每个动作后整体
// 替换），视图模型（含远端会话派生）用 useMemo 在 state 变化时才算一次。
//
// 本 hook 本身不含桌面门控——门控在更上层（装配/路由）决定是否渲染任何启动器界面，
// 因此浏览器/fnOS 永远不会调用到这里。

import { useMemo, useSyncExternalStore } from "react";
import { getLauncherStore, type LauncherStore } from "./launcherStore";
import {
  buildLauncherViewModel,
  type LauncherViewModel,
} from "./launcherViewModel";
import type { RemoteSessionView } from "./remoteSessions";

export interface LauncherSnapshot {
  /** 不可变注册表状态（动作后整体替换）。 */
  state: ReturnType<LauncherStore["getState"]>;
  vm: LauncherViewModel;
  /** nodeId → 已存远端会话（账号/免密态），供组件按需取。 */
  sessions: ReadonlyMap<string, RemoteSessionView>;
  store: LauncherStore;
}

/**
 * 订阅启动器仓库。store 可注入（测试/桌面壳覆盖默认依赖）；生产用浏览器单例。
 */
export function useLauncher(store: LauncherStore = getLauncherStore()): LauncherSnapshot {
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.getState(),
    () => store.getState(),
  );

  const { vm, sessions } = useMemo(() => {
    const list = store.getRemoteSessions();
    const map = new Map<string, RemoteSessionView>(list.map((s) => [s.nodeId, s]));
    return { vm: buildLauncherViewModel(state, map), sessions: map };
  }, [state, store]);

  return { state, vm, sessions, store };
}
