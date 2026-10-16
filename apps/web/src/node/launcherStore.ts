// apps/web/src/node/launcherStore.ts
// 启动器持久化仓库：在 launcher 控制器外包一层「自动存取 + 可订阅」外壳。
//
// - 注册表任何变更后自动写回 storage（键 LAUNCHER_REGISTRY_STORAGE_KEY）；
// - 构造时从 storage parse 初始注册表并 restore()（跨重启恢复上次活动数据源）；
// - 不依赖 React（外部 store：getState/subscribe），UI 用 useSyncExternalStore 接；
// - 远端登录网络动作 loginRemote 注入：S3 接 client.ts 握手/登录，未接时 connectRemote 会失败，
//   不影响"添加节点/连本地/看注册表"等其余能力（门控新增，现网无任何文件 import 本模块）。

import {
  LAUNCHER_REGISTRY_STORAGE_KEY,
  type NodeRegistryState,
  parseRegistry,
  serializeRegistry,
} from "./registry";
import {
  newLauncherController,
  type LauncherController,
  type RemoteLoginFn,
  type SwitchOutcome,
} from "./launcher";
import type { ActiveDataSource, ResolverDeps } from "./datasource";
import type { KvStorage } from "./remoteSessions";

export interface LauncherStoreDeps extends ResolverDeps {
  storage: KvStorage;
  loginRemote?: RemoteLoginFn;
  now?: () => string;
}

export interface LauncherStore {
  /** 当前注册表（不可变引用，动作后整体替换，供 React 浅比较）。 */
  getState(): NodeRegistryState;
  subscribe(fn: () => void): () => void;
  /** 当前活动数据源（无活动为 null）。 */
  getActive(): ActiveDataSource | null;
  controller: LauncherController;
  // 动作（与控制器同名但在变更后自动持久化 + 通知）
  connectLocal(): SwitchOutcome;
  addRemote(input: { nodeId: string; baseURL: string; label?: string | null }): void;
  connectRemote(nodeId: string): Promise<SwitchOutcome>;
  disconnect(nodeId: string): SwitchOutcome;
  removeRemote(nodeId: string): void;
  rename(nodeId: string, label: string | null): void;
}

function browserStorage(): KvStorage | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  const ls = window.localStorage;
  return {
    getItem: (k) => ls.getItem(k),
    setItem: (k, v) => ls.setItem(k, v),
    removeItem: (k) => ls.removeItem(k),
  };
}

/** 构造启动器仓库（注入式，纯 node 可测）。 */
export function createLauncherStore(deps: LauncherStoreDeps): LauncherStore {
  const initial = parseRegistry(deps.storage.getItem(LAUNCHER_REGISTRY_STORAGE_KEY));
  const controller = newLauncherController({ ...deps, initialRegistry: initial });
  // 跨重启：构造即按注册表活动节点 + 已存会话重建活动数据源（resolver setActive）。
  controller.restore();

  const listeners = new Set<() => void>();
  function emit() {
    listeners.forEach((fn) => fn());
  }
  function persist() {
    deps.storage.setItem(LAUNCHER_REGISTRY_STORAGE_KEY, serializeRegistry(controller.getState()));
  }
  // 初始化即写一次（把可能被 parse 收敛过的形状回写，去脏）。
  persist();

  function afterAction<T>(outcome: T): T {
    persist();
    emit();
    return outcome;
  }

  return {
    controller,
    getState: () => controller.getState(),
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getActive: () => {
      const node = controller.getActiveNode();
      if (!node) return null;
      return controller.resolver().current().nodeId === node.nodeId
        ? controller.resolver().current()
        : null;
    },
    connectLocal() {
      return afterAction(controller.connectLocal());
    },
    addRemote(input) {
      controller.addRemote(input);
      afterAction(undefined);
    },
    async connectRemote(nodeId) {
      const outcome = await controller.connectRemote(nodeId);
      persist();
      emit();
      return outcome;
    },
    disconnect(nodeId) {
      return afterAction(controller.disconnect(nodeId));
    },
    removeRemote(nodeId) {
      controller.removeRemote(nodeId);
      afterAction(undefined);
    },
    rename(nodeId, label) {
      controller.rename(nodeId, label);
      afterAction(undefined);
    },
  };
}

let browserSingleton: LauncherStore | null = null;

/**
 * 浏览器单例（懒加载）。桌面 App 启动器 UI 与 S2 client 接线共用这一个仓库。
 * 需在桌面环境注入 getLocalBase/getLocalToken/loginRemote——默认实现：
 * local base/token 与现网一致（datasource 默认读 VITE/gx-auth）；loginRemote 待 S3 注入，
 * 未注入前 connectRemote 直接失败（不影响添加/本地/列表）。
 */
export function getLauncherStore(overrides?: Partial<LauncherStoreDeps>): LauncherStore {
  if (browserSingleton) return browserSingleton;
  const storage = browserStorage();
  if (!storage) throw new Error("启动器仓库需要浏览器 localStorage 环境");
  browserSingleton = createLauncherStore({ storage, ...overrides });
  return browserSingleton;
}

/** 仅供测试重置浏览器单例。 */
export function __resetLauncherStoreForTest(): void {
  browserSingleton = null;
}
