// apps/web/src/node/launcher.ts
// 启动器编排层（DESIGN-MACOS-APP.md §8.5）：把「注册表 registry + 远端会话 remoteSessions +
// 数据源解析器 resolver」串成一致的连接/断开/切换/恢复动作。
//
// 边界：
//   - 本层不发网络请求——远端握手/登录由注入的 loginRemote（S3 接线）提供，纯逻辑可测；
//   - 本层不碰 DOM/localStorage 具体实现，存储与时钟均注入；
//   - 本地节点 token 真相源是 gx-auth（注入 getLocalToken），远端 token 存 remoteSessions 分键；
//   - 仍不接 client.ts 主路径、默认关；resolver 单例在浏览器/fnOS 面 S1 行为（恒 local）不变，
//     只有桌面启动器显式 newLauncherController 后才会驱动 setActive。

import { resolveApiBase } from "../lib/base";
import { createDataSourceResolver, type ActiveDataSource } from "./datasource";
import type { DataSourceResolverController, ResolverDeps } from "./datasource";
import { localWsOrigin, LOCAL_NODE_ID, toWsOrigin } from "./resolve";
import {
  type NodeRegistryState,
  type StoredNodeEntry,
  emptyRegistry,
  addLocalNode,
  addRemoteNode as regAddRemote,
  removeNode as regRemove,
  connectNode as regConnect,
  disconnectNode as regDisconnect,
  renameNode as regRename,
  getEntry,
  activeEntry,
} from "./registry";
import {
  type KvStorage,
  type RemoteSessionView,
  readRemoteSession,
  writeRemoteSession,
  clearRemoteSession,
} from "./remoteSessions";

/** 远端登录/握手结果（S3 接线实现：三探针→POST 登录→返回远端签发 JWT 与用户）。 */
export interface RemoteLoginResult {
  token: string;
  user: RemoteSessionView["user"];
}

/**
 * 用户当次提交的远端凭据（仅在内存中传给登录网络动作，注册表/会话层绝不持久化密码）。
 * 跨重启"记住连接"走已签发的会话 JWT，不依赖密码。
 */
export interface RemoteCredentials {
  email: string;
  password: string;
}

/**
 * 由注入完成"连到某远端并登录"的网络动作。失败应 throw（控制器不切换活动数据源）。
 * @param entry 目标远端节点条目（含 baseURL）
 * @param creds 当次凭据；**已存在有效会话的免密重连路径不会传 creds**（为 undefined）。
 * 纯逻辑测试注入假实现；生产实现走 handshake.ts loginRemoteNode(entry.baseURL, creds)。
 */
export type RemoteLoginFn = (
  entry: StoredNodeEntry,
  creds?: RemoteCredentials,
) => Promise<RemoteLoginResult>;

export interface LauncherDeps extends ResolverDeps {
  storage: KvStorage;
  /** 远端登录网络动作；不传则 connect 远端会失败（仅纯本地场景）。 */
  loginRemote?: RemoteLoginFn;
  now?: () => string;
  /** 初始注册表（从持久层 parse 后传入）；不传＝全新安装空册。 */
  initialRegistry?: NodeRegistryState;
  /**
   * 数据源解析器实例。生产浏览器/桌面必须传入 dataSourceResolver 单例，使启动器切换节点时
   * 驱动的正是 api/client.ts + collab 读取的那一个；纯逻辑测试不传→内部新建独立 resolver。
   */
  resolver?: DataSourceResolverController;
  /**
   * 活动数据源构建器覆盖（W1 成品 Mac 壳注入 shellRouting.deriveShellActiveDataSource 做同源化）。
   * 与默认 deriveActiveDataSource 同形：入参为活动条目（无活动时 applyActive 不调用本函数）+
   * 该节点 token（local=gx-auth，远端=已存会话 JWT），返回交给 resolver 的数据源或 null。
   * **缺省＝deriveActiveDataSource**：浏览器 / fnOS / 服务器面逐字节走现状，不经过任何壳逻辑。
   */
  deriveDs?: (entry: StoredNodeEntry, token: string | null) => ActiveDataSource | null;
}

export interface SwitchOutcome {
  state: NodeRegistryState;
  /** 切换后的活动数据源；无活动节点为 null（UI 应回启动器/添加节点页）。 */
  active: ActiveDataSource | null;
}

/**
 * 纯函数：由活动节点条目 + 凭据推导要交给 resolver 的数据源。
 * 无活动节点 → null。本地节点 baseURL 用注入的本地 base（桌面接线可指向内核回环口）。
 */
export function deriveActiveDataSource(
  entry: StoredNodeEntry | null,
  token: string | null,
  getLocalBase: () => string,
  getOrigin: () => string,
): ActiveDataSource | null {
  if (!entry) return null;
  if (entry.kind === "local") {
    const baseURL = getLocalBase();
    return {
      nodeId: LOCAL_NODE_ID,
      kind: "local",
      baseURL,
      token,
      wsOrigin: localWsOrigin(baseURL, getOrigin()),
    };
  }
  return {
    nodeId: entry.nodeId,
    kind: "remote",
    baseURL: entry.baseURL,
    token,
    wsOrigin: toWsOrigin(entry.baseURL),
  };
}

export interface LauncherController {
  /** 当前注册表快照（不可变，动作返回新状态）。 */
  getState(): NodeRegistryState;
  listNodes(): StoredNodeEntry[];
  getNode(nodeId: string): StoredNodeEntry | null;
  getActiveNode(): StoredNodeEntry | null;
  resolver(): DataSourceResolverController;
  /** 添加并连接本地节点（首次＝壳随后做 boot+初始化；已添加则仅连接）。 */
  connectLocal(): SwitchOutcome;
  /**
   * 仅确保注册表存在 local 条目（addLocalNode 幂等，localDesired="running"），
   * **不** regConnect、**不** applyActive、activeNodeId 不变——独立「启动」按钮用：
   * 先登记期望运行，再由壳 gx:start_local 拉起内核，活动指针仍由随后的「进入本机」切换。
   */
  ensureLocalRegistered(): NodeRegistryState;
  /**
   * 仅改本地条目的期望运行态（不动 activeNodeId、不调 resolver、不停远端会话）。
   * 独立「停止」按钮用：注册表先落 stopped，再由壳 gx:stop_local 优雅停进程。
   * 无 local 条目时安全 no-op（原样返回当前 state）。
   */
  setLocalDesiredOnly(desired: "running" | "stopped"): NodeRegistryState;
  /** 添加远端档案（不连接）。nodeId/baseURL 由 resolve 层规范化后传入。 */
  addRemote(input: { nodeId: string; baseURL: string; label?: string | null }): NodeRegistryState;
  /**
   * 连接远端：
   *   - 已存在该节点的有效会话（跨重启"记住连接"/断开但未删）→ 免密直连，不跑 login；
   *   - 否则用 creds 跑注入登录拿 JWT 落会话，再切活动数据源；creds 缺失或登录失败则 throw、不切换。
   */
  connectRemote(nodeId: string, creds?: RemoteCredentials): Promise<SwitchOutcome>;
  /** 断开：本地→期望停进程；远端→清其会话引用；活动指针回落后 resolver 回 local 兜底。 */
  disconnect(nodeId: string): SwitchOutcome;
  removeRemote(nodeId: string): NodeRegistryState;
  rename(nodeId: string, label: string | null): NodeRegistryState;
  /**
   * 跨重启恢复：按注册表 activeNodeId + 已存会话重建活动数据源。
   * 远端若没有已存会话（未记住/登出过）→ 不自动连，返回 active=null。
   */
  restore(): SwitchOutcome;
}

export function newLauncherController(deps: LauncherDeps): LauncherController {
  // 生产注入 dataSourceResolver 单例（网络/collab 与启动器共用）；测试缺省新建独立实例。
  const resolver =
    deps.resolver ??
    createDataSourceResolver({
      getLocalBase: deps.getLocalBase,
      getOrigin: deps.getOrigin,
      getLocalToken: deps.getLocalToken,
    });
  const getLocalBase =
    deps.getLocalBase ??
    (() =>
      resolveApiBase(
        (import.meta.env.VITE_API_URL as string | undefined) ?? undefined,
        import.meta.env.BASE_URL as string | undefined,
      ));
  const getOrigin = deps.getOrigin ?? (() =>
    (typeof window !== "undefined" ? window.location.origin : "http://localhost"));
  const getLocalToken = deps.getLocalToken ?? (() => null);
  const now = deps.now ?? (() => new Date().toISOString());
  // 活动数据源构建唯一出口：缺省＝现状 deriveActiveDataSource（非壳零变化）；
  // W1 成品壳注入 shellRouting.deriveShellActiveDataSource 把 local/remote 同源化为壳口相对地址。
  const deriveDs =
    deps.deriveDs ??
    ((entry: StoredNodeEntry, token: string | null) =>
      deriveActiveDataSource(entry, token, getLocalBase, getOrigin));

  let state: NodeRegistryState = deps.initialRegistry ?? emptyRegistry();

  function applyActive(nextState: NodeRegistryState): SwitchOutcome {
    const entry = activeEntry(nextState);
    if (!entry) {
      resolver.setActive(null);
      return { state: nextState, active: null };
    }
    if (entry.kind === "local") {
      // 本地允许 token=null（未登录/首启初始化页仍需数据源指向本地内核）。
      const ds = deriveDs(entry, getLocalToken());
      resolver.setActive(ds);
      return { state: nextState, active: ds };
    }
    // 远端：没有已存会话（未记住/登出过）就不自动激活，停在启动器/登录；
    // 在线 connectRemote 路径已先写会话再到这里，token 必非空。
    const token = readRemoteSession(deps.storage, entry.nodeId)?.token ?? null;
    if (!token) {
      resolver.setActive(null);
      return { state: nextState, active: null };
    }
    const ds = deriveDs(entry, token);
    resolver.setActive(ds);
    return { state: nextState, active: ds };
  }

  return {
    getState: () => state,
    listNodes: () => state.entries,
    getNode: (nodeId) => getEntry(state, nodeId),
    getActiveNode: () => activeEntry(state),
    resolver: () => resolver,

    connectLocal() {
      let next = state;
      if (!state.entries.some((e) => e.kind === "local")) {
        const r = addLocalNode(state);
        if (r.error) return { state, active: null };
        next = r.state;
      }
      next = regConnect(next, LOCAL_NODE_ID, now()).state;
      state = next;
      return applyActive(next);
    },

    ensureLocalRegistered() {
      if (state.entries.some((e) => e.kind === "local")) return state;
      const r = addLocalNode(state);
      // addLocalNode 仅在已存在 local 时失败；上一行已排除，error 必为 null。
      if (!r.error) state = r.state;
      return state;
    },

    setLocalDesiredOnly(desired) {
      // 无本地条目：localDesired 无意义，安全 no-op（不改 active、不调 resolver）。
      if (!state.entries.some((e) => e.kind === "local")) return state;
      if (state.localDesired === desired) return state;
      state = { ...state, localDesired: desired };
      return state;
    },

    addRemote(input) {
      const r = regAddRemote(state, input);
      if (!r.error) state = r.state;
      return state;
    },

    async connectRemote(nodeId, creds) {
      const entry = getEntry(state, nodeId);
      if (!entry || entry.kind !== "remote") {
        return { state, active: null };
      }
      // 已存有效会话（跨重启记住/曾连过未删）→ 免密直连，不再跑登录。
      // 需要强制换账号重登时，UI 先走 disconnect（清该节点会话）再带 creds 连接。
      const existing = readRemoteSession(deps.storage, nodeId);
      if (!existing) {
        if (!deps.loginRemote) return { state, active: null };
        // 登录失败会 throw，控制器在此之前不改 state / resolver / 会话（调用方捕获提示）。
        // 生产 loginRemote 适配器在 creds 缺失时会因缺账号密码自然失败；纯逻辑测试可注入免参 mock。
        const result = await deps.loginRemote(entry, creds);
        writeRemoteSession(deps.storage, {
          nodeId,
          token: result.token,
          user: result.user,
        });
      }
      const next = regConnect(state, nodeId, now()).state;
      state = next;
      return applyActive(next);
    },

    disconnect(nodeId) {
      const entry = getEntry(state, nodeId);
      if (!entry) return applyActive(state);
      if (entry.kind === "remote") clearRemoteSession(deps.storage, nodeId);
      const next = regDisconnect(state, nodeId).state;
      state = next;
      return applyActive(next);
    },

    removeRemote(nodeId) {
      const entry = getEntry(state, nodeId);
      if (entry?.kind === "remote") clearRemoteSession(deps.storage, nodeId);
      const r = regRemove(state, nodeId);
      if (!r.error) state = r.state;
      return state;
    },

    rename(nodeId, label) {
      const r = regRename(state, nodeId, label);
      if (!r.error) state = r.state;
      return state;
    },

    restore() {
      return applyActive(state);
    },
  };
}

