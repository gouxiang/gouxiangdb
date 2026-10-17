// apps/web/src/node/installLauncher.ts
// 启动器的**生产装配点**（DESIGN-MACOS-APP.md §8.5；主设计 §8.5 单活会话）。
//
// 唯一职责：在桌面门控开启时，把 S2 已建好的「远端 401 分流桥」接到启动器仓库——
// 当前活动远端节点会话失效（改密/停用/踢人致下一个请求 401）时，断开该节点：
// 清其远端会话、活动指针回落 null（resolver 惰性回 local 兜底），启动器 UI 订阅到
// activeNodeId=null 即回到「连接/登录该节点」界面。**绝不**清本地 gx-auth、不跳本地登录页。
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
    // client.ts 仅在当前数据源是该远端节点时才通知，故这里断开的必是活动节点；
    // disconnect 对远端清会话、活动指针置 null（resolver 回 local 兜底）。
    // 不 await（保持原 fire-and-forget 分流语义）；壳模式其内部还会 set_upstream(none)，
    // 失败不改变已提交的断开结果。Promise.resolve 包裹对历史返回 undefined 的测试替身也安全。
    void Promise.resolve(store.disconnect(nodeId)).catch(() => undefined);
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
