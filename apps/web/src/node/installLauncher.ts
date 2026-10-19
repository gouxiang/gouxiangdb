// apps/web/src/node/installLauncher.ts
// 启动器的**生产装配点**（DESIGN-MACOS-APP.md §8.5；主设计 §8.5 单活会话）。
//
// 唯一职责：在桌面门控开启时，把 S2 已建好的「远端 401 分流桥」接到启动器仓库——
// 当前活动远端节点会话失效（改密/停用/踢人致下一个请求 401）时，对该节点**去认证但保持选路**：
// 清其远端会话分键、活动指针仍指该远端、壳上游仍转发该远端，resolver 重推 token=null 的
// remote-empty 数据源；路由守卫据 useActiveSession 把用户送回**同一远端节点自己的登录页**，
// 而不是回启动器列表。**绝不** disconnect（不 regDisconnect、不 set_upstream(none)）、
// 不清本地 gx-auth、不跳本地登录页。用户可随时离开（在启动器另选节点）。
//
// 浏览器 / fnOS / 服务器构建不注入门控标志 → launcherEnabled()=false → 本函数 no-op，
// 不构造仓库、不注册处理器、import 它本身也无副作用（装配须由入口显式调用，S4-3 接线）。

import { launcherEnabled } from "./desktopGate";
import { getLauncherStore, type LauncherStore } from "./launcherStore";
import {
  registerRemoteUnauthorizedHandler,
  type RemoteUnauthorizedHandler,
} from "./unauthorizedBridge";

export interface LauncherInstall {
  /** 是否已实际装配（门控关闭时为 false，store 为 null）。 */
  installed: boolean;
  store: LauncherStore | null;
  /** 卸载：注销 401 处理器（测试/热更用）。门控关闭时为 no-op。 */
  cleanup(): void;
}

/**
 * 装配启动器运行时（仅桌面门控开启时有副作用）。
 * @param enabled 覆盖门控（测试注入）；缺省读构建标志 VITE_NODE_LAUNCHER。
 * @param store   覆盖仓库（测试注入）；缺省取浏览器单例。
 */
export function installLauncher(options?: {
  enabled?: boolean;
  store?: LauncherStore;
}): LauncherInstall {
  const enabled = options?.enabled ?? launcherEnabled();
  if (!enabled) {
    return { installed: false, store: null, cleanup() {} };
  }

  const store = options?.store ?? getLauncherStore();
  const handler: RemoteUnauthorizedHandler = (nodeId) => {
    // client.ts 仅在当前数据源是该远端节点时才通知，故这里去认证的必是活动节点。
    // deauthenticateRemote 只清该节点会话分键并重推 token=null 数据源（remote-empty），
    // 不 regDisconnect、活动指针不动、壳上游仍指该远端——守卫据此把用户送回该远端自己的
    // 登录页。不 await（保持 fire-and-forget 分流语义）；该动作无壳副作用、不会 reject，
    // Promise.resolve 包裹对历史返回 undefined 的测试替身也安全。
    void Promise.resolve(store.deauthenticateRemote(nodeId)).catch(() => undefined);
  };
  registerRemoteUnauthorizedHandler(handler);

  return {
    installed: true,
    store,
    cleanup() {
      registerRemoteUnauthorizedHandler(null);
    },
  };
}
