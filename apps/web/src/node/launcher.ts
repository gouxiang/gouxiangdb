// apps/web/src/node/launcher.ts
// 启动器编排层（DESIGN-MACOS-APP.md §8.5）：把「注册表 registry + 远端会话 remoteSessions +
// 数据源解析器 resolver」串成一致的连接/断开/切换/恢复动作。
//
// 边界：
//   - 本层不发网络请求——「连接＝只选路」（2026-10 拍板）：connectRemote 只切活动指针/数据源，
//     不再代登录；远端节点的登录/改密/首管理员引导全部由该节点自己的页面（apiFetch 经活动源）
//     承担，成功后由 activeAuth 调 commitRemoteSession 把 JWT 写入该节点分键。deps.loginRemote
//     仅为旧装配/测试保留的可注入项，纯选路路径不再调用；
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
   * 连接远端＝**只选路**（2026-10 拍板，覆盖旧"带账号密码登录"语义）：
   *   - 不发任何登录请求、不读不写远端会话、不吃 creds（形参保留只为调用签名兼容，显式忽略）；
   *   - 仅把活动指针指向该节点（regConnect）并重推活动数据源；
   *   - 该节点已有记住的会话 JWT → 活动数据源带 token（直接进得去）；没有会话 → 活动数据源
   *     是 token=null 的远端槽（remote-empty），壳上游仍切到该远端，界面随即展示**该远端节点
   *     自己的登录页**，登录/改密/首管理员引导全部由远端页面承担。
   * 可毫秒级往返、可随时离开；节点不存在或不是远端 → active=null 且不切换。
   */
  connectRemote(nodeId: string, creds?: RemoteCredentials): Promise<SwitchOutcome>;
  /**
   * 远端登录/注册成功后，把该节点签发的 JWT + user 写入它自己的会话分键（gx-node-session:<id>）。
   * 若该节点正是当前活动节点，重推带 token 的活动数据源（remote-empty → 已登录远端）；
   * 若是非活动节点，只写会话（记住账号），不动当前活动源。拒绝空 token/local 节点（会话层已守）。
   */
  commitRemoteSession(nodeId: string, token: string, user: RemoteSessionView["user"]): SwitchOutcome;
  /**
   * 局部更新某远端会话里的 user（改密成功但 me() 拉取失败时的本地兜底）。会话不存在则 no-op。
   * 只改分键信封，不重推活动数据源（数据源只携带 token、不携带 user）。
   */
  patchRemoteSessionUser(nodeId: string, patch: Partial<NonNullable<RemoteSessionView["user"]>>): void;
  /**
   * 远端会话失效（401/登出）：清该节点会话，但**保持选路态**——activeNodeId 不变、不 regDisconnect、
   * 不回落 local、不改壳上游；若它是当前活动节点，重推 token=null 的远端数据源（remote-empty），
   * 守卫据此把用户送回**该远端节点的登录页**。与 disconnect 的区别：disconnect 会把活动指针置 null。
   */
  deauthenticateRemote(nodeId: string): SwitchOutcome;
  /** 断开：本地→期望停进程；远端→清其会话引用；活动指针回落后 resolver 回 local 兜底。 */
  disconnect(nodeId: string): SwitchOutcome;
  removeRemote(nodeId: string): NodeRegistryState;
  rename(nodeId: string, label: string | null): NodeRegistryState;
  /**
   * 跨重启恢复：按注册表 activeNodeId + 已存会话重建活动数据源。
   * 远端若没有已存会话（未记住/登出过）→ 不自动连，返回 active=null（restore 不做 remote-empty）。
   * 注意：在线 connectRemote 走 allowEmptyRemote=true 的纯选路，可激活 token=null 的远端槽；
   * 恢复路径刻意保持旧 fail-closed 语义，避免重启后壳上游指向一个必然要重登的远端。
   */
  restore(): SwitchOutcome;
  /**
   * 本机活动节点登录态刷新（成品壳「先连本机、后登录/注册」专用）：connectLocal 当拍往往
   * 尚未登录（token=null），resolver 冻结的是那份空令牌快照；登录成功 gx-auth 令牌到位后，
   * 由装配层订阅触发本方法，用最新 getLocalToken() 重新推导并 setActive 活动数据源，
   * 使随后的业务请求能带上 X-GX-Token。**只**在当前活动节点是本机时生效，其余返回 null；
   * 不碰注册表、不切壳上游、不清远端会话（nodeId 仍为 local，queryClient 桥不会清缓存）。
   */
  refreshActiveLocal(): SwitchOutcome | null;
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

  /**
   * @param allowEmptyRemote 在线「只选路」connectRemote 传 true：远端无会话也激活 token=null 的
   *   远端数据源（remote-empty，界面随即展示远端自己的登录页）。缺省 false 保持旧语义
   *   （restore/disconnect：远端无会话不自动激活，回落 active=null → resolver 惰性回 local）。
   */
  function applyActive(
    nextState: NodeRegistryState,
    allowEmptyRemote = false,
  ): SwitchOutcome {
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
    // 远端：token 取该节点记住的会话 JWT；没有会话则为 null（remote-empty）。
    // 在线纯选路（allowEmptyRemote）允许空 token 激活——壳上游仍切到该远端，登录交给远端页面；
    // 恢复/断开路径（缺省）维持旧的"无会话不自动连"，回落 active=null。
    const token = readRemoteSession(deps.storage, entry.nodeId)?.token ?? null;
    if (!token && !allowEmptyRemote) {
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
      // 「连接＝只选路」：creds 已不再使用（登录由远端节点自己的页面承担）。显式 void 标注，
      // 保留形参仅为调用签名兼容（addRemoteFlow/UI/测试替身），绝不发登录请求、不读写会话。
      void creds;
      const entry = getEntry(state, nodeId);
      if (!entry || entry.kind !== "remote") {
        return { state, active: null };
      }
      // 有记住的会话 → 活动数据源带 JWT（免登直接进）；无会话 → token=null 远端槽（remote-empty），
      // 壳上游照样切到该远端，界面随即展示远端自己的 /login。两种情况都只做选路，毫秒级。
      const next = regConnect(state, nodeId, now()).state;
      state = next;
      return applyActive(next, true);
    },

    commitRemoteSession(nodeId, token, user) {
      const entry = getEntry(state, nodeId);
      if (!entry || entry.kind !== "remote") {
        // 非远端/未知节点：不写会话（writeRemoteSession 自身也拒 local），活动源不变。
        return applyActive(state);
      }
      // writeRemoteSession 拒绝空 token、拒绝 local；失败 throw，调用方（登录页）按错误提示。
      writeRemoteSession(deps.storage, { nodeId, token, user: user ?? null });
      // 仅当该节点是当前活动节点时才重推数据源（remote-empty → 已登录远端）；
      // 给非活动节点"记住账号"不改当前看的源。
      if (state.activeNodeId === nodeId) return applyActive(state, true);
      return { state, active: activeEntry(state) ? resolver.current() : null };
    },

    patchRemoteSessionUser(nodeId, patch) {
      const existing = readRemoteSession(deps.storage, nodeId);
      if (!existing || !existing.user) return; // 无会话/无 user 可补：no-op。
      writeRemoteSession(deps.storage, {
        nodeId,
        token: existing.token,
        user: { ...existing.user, ...patch },
      });
    },

    deauthenticateRemote(nodeId) {
      const entry = getEntry(state, nodeId);
      if (!entry || entry.kind !== "remote") {
        return applyActive(state);
      }
      // 清该远端会话，但**保持选路态**：不 regDisconnect、activeNodeId 不变。
      clearRemoteSession(deps.storage, nodeId);
      if (state.activeNodeId === nodeId) {
        // 活动节点：重推 token=null 远端数据源（remote-empty），守卫送回远端自己的登录页，
        // 壳上游仍指向该远端（installLauncher/store 在此不改 set_upstream）。
        return applyActive(state, true);
      }
      // 非活动节点：仅清会话，当前活动数据源无需变动。
      return { state, active: activeEntry(state) ? resolver.current() : null };
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

    refreshActiveLocal() {
      const entry = activeEntry(state);
      // 仅本机活动节点需要随 gx-auth 登录态刷新；无活动或当前是远端 → 不动（返回 null 表示未刷新）。
      if (!entry || entry.kind !== "local") return null;
      // 复用 applyActive：它对 local 分支每次实时 getLocalToken() 重新 deriveDs 并 setActive。
      // 注册表 state 不变，仅 resolver 内冻结的 token 快照被替换；nodeId 不变，切源桥不清缓存。
      return applyActive(state);
    },
  };
}

