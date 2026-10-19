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
  type StoredNodeEntry,
  parseRegistry,
  remoteEntries,
  serializeRegistry,
} from "./registry";
import {
  newLauncherController,
  type LauncherController,
  type RemoteCredentials,
  type RemoteLoginFn,
  type SwitchOutcome,
} from "./launcher";
import {
  dataSourceResolver,
  type ActiveDataSource,
  type DataSourceResolverController,
  type ResolverDeps,
} from "./datasource";
import type { KvStorage, RemoteSessionView } from "./remoteSessions";
import { readAllRemoteSessions, readRemoteSession } from "./remoteSessions";
import type { UserDTO } from "@gx/shared-types";
import { resolveApiBase } from "../lib/base";
import { useAuthStore } from "../store/auth";
import { loginRemoteNode } from "./handshake";
import type { NodeHandshake } from "./handshake";
import { launcherEnabled } from "./desktopGate";
import {
  hasShell,
  localStatus,
  setActiveUpstream,
  startLocal,
  stopLocal as stopLocalCmd,
} from "./shellBridge";
import { deriveShellActiveDataSource, normalizeProbeBaseURL } from "./shellRouting";
import { probeLoginRemote, probePerformHandshake } from "./shellProbe";

/**
 * 成品 Mac 壳模式的副作用钩子（W1 §4 line 147/149）。仅在 hasShell() 且桌面门控开启时由
 * shellDefaultDeps 提供；非壳（浏览器 / fnOS / 服务器）恒为 undefined，store 走与现状逐字节
 * 一致的同步分支。接口只描述编排时机，壳命令实现在 shellBridge / shellProbe。
 */
export interface ShellStoreHooks {
  /**
   * connectLocal 切换数据源**之前**确保本地内核已启动就绪（gx:start_local 内部已轮询 readyz）。
   * 启动失败（{ok:false,error}）应 throw 中文错误——此时控制器不切换、不持久化、不通知。
   */
  ensureLocalReady(): Promise<void>;
  /**
   * 控制器把活动数据源切换为同源描述之后、store emit 通知 UI **之前**，把壳内 Mutex<Upstream>
   * 与新活动源对齐：null→none、local→local、remote→remote（target 为注册表保存的真实基址）。
   * 在 emit 前 await，保证界面重取/WS 重连绝不早于壳代理切换上游。
   */
  syncUpstream(
    active: ActiveDataSource | null,
    activeEntry: StoredNodeEntry | null,
  ): Promise<void>;
  /**
   * 断开**本地节点**后停掉本地内核进程（gx:stop_local：SIGTERM 优雅停、不删数据）。
   * 仅当 disconnect 目标是本地条目时由 store 调用；远端断开不停本地进程。
   */
  stopLocal(): Promise<void>;
  /**
   * 独立「启动」：注册表已先登记 local 条目（localDesired=running）后调 gx:start_local。
   * **不**切换活动数据源、**不** set_upstream（那是「进入本机」connectLocal 的职责）。
   * 返回 firstBoot=本次是否首次初始化（added 或 initialized 此前为假），供 UI 显示首启慢提示。
   */
  startLocalOnly(): Promise<{ firstBoot: boolean }>;
  /** 独立「停止」：gx:stop_local 优雅停进程。不动活动指针/壳上游（注册表侧已先落 stopped）。 */
  stopLocalOnly(): Promise<void>;
}

export interface LauncherStoreDeps extends ResolverDeps {
  storage: KvStorage;
  loginRemote?: RemoteLoginFn;
  now?: () => string;
  /** 数据源解析器；生产传 dataSourceResolver 单例，缺省由控制器内部新建（测试）。 */
  resolver?: DataSourceResolverController;
  /**
   * 活动数据源构建器覆盖；壳模式传 shellRouting.deriveShellActiveDataSource（local/remote 同源化）。
   * 缺省控制器回落 deriveActiveDataSource（非壳零变化）。
   */
  deriveDs?: (entry: StoredNodeEntry, token: string | null) => ActiveDataSource | null;
  /** 成品壳副作用钩子；不传＝非壳模式，connect/disconnect 走现状同步路径。 */
  shell?: ShellStoreHooks;
  /**
   * 成品壳本机登录态监听（仅 deps.shell 存在时被订阅）：gx-auth 令牌变化（登录/注册成功、
   * 登出、跨重启 hydrate）时回调一次，store 据此 refreshActiveLocal() 把 connectLocal 当拍
   * 冻结的空令牌快照刷新成最新令牌。返回取消订阅。壳生产实现订阅 useAuthStore；非壳不传，零接线。
   */
  watchLocalToken?: (onChange: () => void) => () => void;
  /**
   * 成品壳「添加远端节点」握手工厂（probe 同源转发）；非壳为 undefined，addAndConnectRemote
   * 缺省对显式 baseURL 直连握手。入参为可选最低兼容节点版本（透传 AddRemoteNodeForm）。
   */
  probeHandshake?: (
    minNodeVersion?: string,
  ) => (baseURL: string) => Promise<NodeHandshake>;
}

export interface LauncherStore {
  /** 当前注册表（不可变引用，动作后整体替换，供 React 浅比较）。 */
  getState(): NodeRegistryState;
  subscribe(fn: () => void): () => void;
  /** 当前活动数据源（无活动为 null）。 */
  getActive(): ActiveDataSource | null;
  /**
   * 当前注册表里所有远端节点的已存会话（按 nodeId 分键读取，供启动器列表显示账号/免密态）。
   * 只含当前注册表中存在的远端节点，不扫描整个 localStorage；本地 gx-auth 不在内。
   */
  getRemoteSessions(): RemoteSessionView[];
  /** 读单个远端节点的已存会话（无则 null）；供活动会话 hook 取远端 user。 */
  getRemoteSession(nodeId: string): RemoteSessionView | null;
  controller: LauncherController;
  /**
   * 是否为成品壳装配（deps.shell 存在）。UI 据此把原本直连 controller 的凭据重连端口
   * （ConnectNodeForm）在壳模式改道到 store.connectRemote——只有经 store 才会包 set_upstream
   * 副作用。非壳恒 false，UI 走现状直连 controller，行为逐字节不变。
   */
  readonly shellBound: boolean;
  /**
   * 冷启动把壳代理上游补切到「跨重启恢复出的活动远端」的完成承诺。
   * 背景：Rust 壳进程的代理上游恒从 Upstream::None 启动且**不跨进程持久化**
   *（apps/desktop/src-tauri/src/upstream.rs），只有 gx:set_active_upstream 会改它；
   * 而本仓库构造即 restore() 把 web 侧 resolver 指回上次活动节点。二者之间的缺口在
   * 「App 冷启动 + 上次活动是已登录远端」时会让首个 /api 请求打到 None → 503。
   * 故构造后仅在**壳装配 + 恢复活动节点是远端**时补一次 syncUpstream(remote)；
   * 活动节点是本机时**绝不** syncUpstream local（内核冷启动未必在跑，维持由用户点
   * 「进入本机」触发 start_local 的现状）；非壳/无活动远端恒为已 resolve，零行为变化。
   * 失败不阻塞首屏（吞掉、壳上游保持 None），用户随后点连接会再切。
   */
  readonly restoreReady: Promise<void>;
  // 动作（与控制器同名但在变更后自动持久化 + 通知）
  /**
   * 连接本地。非壳模式：函数体零 await，状态在调用当拍同步提交（返回 Promise 仅为统一壳模式
   * 异步拉起内核的签名，SSR/同步读取与旧同步版本逐拍等价）；壳模式：先 await start_local 就绪，
   * 失败则 throw 且不切换，成功后同源化数据源并把壳上游切到 local。
   */
  connectLocal(): Promise<SwitchOutcome>;
  addRemote(input: { nodeId: string; baseURL: string; label?: string | null }): void;
  connectRemote(nodeId: string, creds?: RemoteCredentials): Promise<SwitchOutcome>;
  /**
   * 远端登录/注册成功后，把 JWT+user 写入该节点会话分键；活动节点同时重推带 token 的数据源
   * （remote-empty → 已登录远端）。会话写在 remoteSessions 分键，**不**改注册表，故无需 persist
   * 注册表；但要 emit 让订阅会话视图的 UI（账号/免密态）刷新。**不** syncUpstream——选路时
   * （connectRemote）壳上游已切到该远端，补 token 不改变上游目标。
   */
  commitRemoteSession(nodeId: string, token: string, user: UserDTO | null): SwitchOutcome;
  /** 局部更新某远端会话的 user（改密成功但 me() 失败时的本地兜底）。不改注册表、不通知、不切上游。 */
  patchRemoteSessionUser(nodeId: string, patch: Partial<UserDTO>): void;
  /**
   * 远端会话失效（401）：清该节点会话但**保持选路态**（活动指针不变、壳上游仍指该远端），
   * 活动节点重推 token=null 数据源（remote-empty），守卫把用户送回该远端自己的登录页。
   * 与 disconnect 的差别：不 regDisconnect、activeNodeId 不置 null、**不** set_upstream(none)。
   * 同步动作（无壳副作用），但返回 Promise 仅为与 disconnect 调用点签名统一。
   */
  deauthenticateRemote(nodeId: string): Promise<SwitchOutcome>;
  /** 同 connectLocal：非壳零 await 同步提交；壳模式切换后把壳上游对齐（远端/none）。 */
  disconnect(nodeId: string): Promise<SwitchOutcome>;
  /**
   * 独立启动本机内核（与「进入本机」connectLocal 拆开）：只登记 local 条目 +
   * localDesired=running 并在壳内 await gx:start_local；**不**切换活动数据源、**不** set_upstream。
   * 非壳：注册+持久化+通知后回 {firstBoot:false}，不触达任何壳命令（测试可驱动）。
   */
  startLocalOnly(): Promise<{ firstBoot: boolean }>;
  /**
   * 独立停止本机内核：注册表先落 localDesired=stopped（条目保留、activeNodeId 不变），
   * 壳内 await gx:stop_local；不 disconnect、不 set_upstream(none)。非壳只做注册表部分。
   */
  stopLocalOnly(): Promise<void>;
  removeRemote(nodeId: string): void;
  rename(nodeId: string, label: string | null): void;
  /**
   * 成品壳本机登录态刷新：当前活动节点是本机且 gx-auth 令牌刚到位（登录/注册成功、跨重启
   * hydrate）后，用最新本地令牌重新 setActive 同源化数据源。非本机活动/无活动返回 null。
   * 仅改 resolver 冻结的 token 快照（resolver 内部会通知切源桥；nodeId 不变故不清缓存），
   * 不写注册表、不 store emit、不切壳上游。
   */
  refreshActiveLocal(): SwitchOutcome | null;
  /**
   * 成品壳「添加远端节点」握手工厂（probe 同源转发）；非壳为 undefined，AddRemoteNodeForm
   * 不传 performHandshake，addAndConnectRemote 缺省对显式 baseURL 直连（浏览器零变化）。
   */
  addHandshake?: (
    minNodeVersion?: string,
  ) => (baseURL: string) => Promise<NodeHandshake>;
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
  const restored = controller.restore();

  // 冷启动补切壳代理上游（弥补 Rust 上游不跨进程持久化，见接口 restoreReady 注释）：
  // 仅壳装配 + 恢复出的活动节点确为远端时，把壳内 Mutex<Upstream> 对齐到该远端。
  // - 活动节点是本机：不 syncUpstream local（冷启动内核未必在跑，由用户点「进入本机」
  //   经 connectLocal 的 start_local+sync 触发，保持现状）；
  // - 无活动节点 / 非壳：恒为已 resolve，不发任何 invoke；
  // - 同步失败不阻塞首屏（catch 吞掉、上游保持 None），随后用户点连接会再切。
  let restoreReady: Promise<void> = Promise.resolve();
  if (deps.shell && restored.active && controller.getActiveNode()?.kind === "remote") {
    restoreReady = deps.shell
      .syncUpstream(restored.active, controller.getActiveNode())
      .then(() => undefined)
      .catch(() => undefined);
  }

  const listeners = new Set<() => void>();
  function emit() {
    listeners.forEach((fn) => fn());
  }
  function persist() {
    deps.storage.setItem(LAUNCHER_REGISTRY_STORAGE_KEY, serializeRegistry(controller.getState()));
  }
  // 初始化即写一次（把可能被 parse 收敛过的形状回写，去脏）。
  persist();

  // 成品壳：订阅 gx-auth 令牌。壳是「先连本机、后登录/注册」，connectLocal 当拍冻结的数据源
  // 令牌为 null；登录成功令牌到位后，这里把本机活动节点的冻结快照刷新成最新令牌，随后的业务
  // 请求才带得上 X-GX-Token（修复「登录成功立刻被弹回登录页」）。仅壳装配（deps.shell）接线；
  // 非壳不传 watchLocalToken，零订阅、零行为变化。nodeId 恒为 local，切源桥不会清 react-query。
  if (deps.shell && deps.watchLocalToken) {
    deps.watchLocalToken(() => {
      controller.refreshActiveLocal();
    });
  }

  function afterAction<T>(outcome: T): T {
    persist();
    emit();
    return outcome;
  }

  return {
    controller,
    shellBound: deps.shell !== undefined,
    restoreReady,
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
    getRemoteSessions: () =>
      readAllRemoteSessions(
        deps.storage,
        remoteEntries(controller.getState()).map((e) => e.nodeId),
      ),
    // 读单个远端节点的会话（供活动会话 hook 取远端 user/守卫判定 mustChangePassword）。
    getRemoteSession: (nodeId: string) => readRemoteSession(deps.storage, nodeId),
    // ── 非壳分支函数体内零 await：async 函数在首个 await 前同步执行到底，
    //    故浏览器/fnOS（deps.shell 缺省）下 persist/emit 与旧同步版本同拍发生，SSR 与同步测试零漂移。
    async connectLocal() {
      if (deps.shell) {
        // 成品壳：先确保本地内核启动并 /readyz 就绪（内部含首 boot）。失败直接 throw：
        // 控制器不切换、注册表不写 running、不通知（调用方显示中文 error，W2 接进度 UI）。
        await deps.shell.ensureLocalReady();
      }
      const outcome = controller.connectLocal();
      persist();
      if (deps.shell) {
        // 数据源已同源化（deriveShellActiveDataSource），再让壳代理把上游切到本地内核。
        await deps.shell.syncUpstream(outcome.active, controller.getActiveNode());
      }
      emit();
      return outcome;
    },
    addRemote(input) {
      controller.addRemote(input);
      afterAction(undefined);
    },
    async connectRemote(nodeId, creds) {
      const outcome = await controller.connectRemote(nodeId, creds);
      persist();
      if (deps.shell) {
        // 登录/免密重连成功、resolver 已切到同源远端数据源后，原子切换壳代理上游到该远端
        //（target=注册表保存的真实 http(s) 基址；JWT 仍由 X-GX-Token 透传，壳不持令牌）。
        await deps.shell.syncUpstream(outcome.active, controller.getActiveNode());
      }
      emit();
      return outcome;
    },
    commitRemoteSession(nodeId, token, user) {
      // 会话写的是 remoteSessions 分键（控制器内部写 storage），注册表形状不变 → 无需 persist 注册表。
      const outcome = controller.commitRemoteSession(nodeId, token, user);
      // 不 syncUpstream：选路时壳上游已指向该远端，补 token 不改变上游目标。
      emit();
      return outcome;
    },
    patchRemoteSessionUser(nodeId, patch) {
      controller.patchRemoteSessionUser(nodeId, patch);
    },
    async deauthenticateRemote(nodeId) {
      // 清会话但保持选路态：控制器不 regDisconnect、activeNodeId 不变；壳上游**不**改（仍指该远端），
      // 故这里刻意不调 deps.shell.syncUpstream。注册表未变也无需 persist；仍 emit 让会话视图刷新。
      const outcome = controller.deauthenticateRemote(nodeId);
      emit();
      return outcome;
    },
    async disconnect(nodeId) {
      // 先判条目类型（控制器变更前），决定是否需要停本地内核。
      const wasLocal = controller.getNode(nodeId)?.kind === "local";
      const outcome = controller.disconnect(nodeId);
      persist();
      if (deps.shell) {
        // 注册表/数据源已回落（active=null，resolver 惰性回 local 兜底）。本地断开先优雅停内核，
        // 再把壳上游置 none（§3：停后上游不得再指向 Local）；远端断开直接 none（回 503 引导回启动器）。
        if (wasLocal) await deps.shell.stopLocal();
        await deps.shell.syncUpstream(null, null);
      }
      emit();
      return outcome;
    },
    async startLocalOnly() {
      // 注册表先登记 local 条目（addLocalNode 设 localDesired=running），不动活动指针/resolver。
      controller.ensureLocalRegistered();
      persist();
      let firstBoot = false;
      if (deps.shell) {
        firstBoot = (await deps.shell.startLocalOnly()).firstBoot;
      }
      emit();
      return { firstBoot };
    },
    async stopLocalOnly() {
      // 仅落期望停止：不 disconnect、不删条目、不改 activeNodeId、不 set_upstream。
      controller.setLocalDesiredOnly("stopped");
      persist();
      if (deps.shell) {
        await deps.shell.stopLocalOnly();
      }
      emit();
    },
    removeRemote(nodeId) {
      controller.removeRemote(nodeId);
      afterAction(undefined);
    },
    rename(nodeId, label) {
      controller.rename(nodeId, label);
      afterAction(undefined);
    },
    refreshActiveLocal() {
      // 仅壳「先连本机、后登录」需要：把 connectLocal 当拍冻结的空令牌快照刷新为最新 gx-auth。
      // 控制器内部只在活动节点确为本机时重推数据源；非本机/无活动返回 null（无任何副作用）。
      return controller.refreshActiveLocal();
    },
    // 壳模式提供 probe 握手工厂；非壳为 undefined（AddRemoteNodeForm 回落直连握手）。
    addHandshake: deps.probeHandshake,
  };
}

let browserSingleton: LauncherStore | null = null;

/**
 * 浏览器/桌面生产默认依赖（DESIGN §8.5）：
 *   - resolver 传 dataSourceResolver 单例，保证启动器切换驱动的正是 client.ts/collab 读的那一个；
 *   - local base/origin/token 与 datasource 单例默认构建同口径（local 逐字节等价）；
 *   - loginRemote 适配器：用节点条目 baseURL + 当次凭据调 handshake.loginRemoteNode 换远端 JWT。
 * 任何字段都可被 overrides 覆盖（测试/桌面壳指向内核回环口时覆盖 getLocalBase）。
 */
function browserDefaultDeps(): Omit<LauncherStoreDeps, "storage"> {
  return {
    resolver: dataSourceResolver,
    getLocalBase: () =>
      resolveApiBase(
        (import.meta.env.VITE_API_URL as string | undefined) ?? undefined,
        import.meta.env.BASE_URL as string | undefined,
      ),
    getOrigin: () =>
      (typeof window !== "undefined" ? window.location.origin : "http://localhost"),
    getLocalToken: () => useAuthStore.getState().token ?? null,
    loginRemote: async (entry, creds) => {
      if (!creds) throw new Error("连接该远端节点需要账号密码");
      return loginRemoteNode({
        baseURL: entry.baseURL,
        email: creds.email,
        password: creds.password,
      });
    },
  };
}

/**
 * 成品 Mac 壳生产依赖（W1 §4 line 147-150）。**仅**在 hasShell()（存在 Tauri 全局命令通道）
 * 且桌面门控 VITE_NODE_LAUNCHER 开启时由 getLauncherStore 选用；浏览器 / fnOS / 服务器构建
 * hasShell()=false，永远走 browserDefaultDeps，本函数不被触达。
 *
 * 与浏览器版的差别仅在「地址面 + 壳命令副作用」：
 *   - getLocalBase 恒 ""、deriveDs 用 shellRouting 同源化构建器 → local/remote 的 ActiveDataSource
 *     都是壳口同源相对地址（resolver setActive(null) 的 buildLocal 兜底也因 getLocalBase="" 而同源）；
 *   - loginRemote / probeHandshake 改走 shellProbe 的 begin_probe→同源 probe→end_probe；
 *   - shell 钩子在 connect/disconnect 时把壳内 Mutex<Upstream> 与活动源对齐（start/stop/set_upstream）。
 * 身份字段（nodeId/kind/token）与 queryClient.clear()、远端 401 分流语义不变。
 */
function shellDefaultDeps(): Omit<LauncherStoreDeps, "storage"> {
  const getOrigin = () =>
    typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1";
  return {
    resolver: dataSourceResolver,
    // 壳口根部署（VITE_BASE_PATH=/），一切业务请求同源经壳代理按当前上游转发。
    getLocalBase: () => "",
    getOrigin,
    getLocalToken: () => useAuthStore.getState().token ?? null,
    deriveDs: (entry, token) => deriveShellActiveDataSource(entry, token, getOrigin),
    // 订阅 gx-auth 令牌：登录/注册成功（setAuth）后把本机活动数据源冻结的空令牌刷新为最新值。
    // zustand 原生 subscribe 回调为 (state, prevState)；仅在 token 真正变化（登录/登出）时刷新，
    // updateUser 等无关变更不触发。localStorage persist 同步 hydrate，故拿到的总是最新登录态。
    // 仅壳装配消费（见 createLauncherStore 内 deps.shell 门控）。
    watchLocalToken: (onChange) =>
      useAuthStore.subscribe((state, prev) => {
        if (state.token !== prev.token) onChange();
      }),
    loginRemote: probeLoginRemote,
    probeHandshake: probePerformHandshake,
    shell: {
      // start_local 内部已做冷备/migrate/spawn/readyz 轮询；ok:false 的中文 error 直接抛给 UI。
      async ensureLocalReady() {
        const r = await startLocal();
        if (!r.ok) throw new Error(r.error);
      },
      async syncUpstream(active, entry) {
        if (!active || !entry) {
          await setActiveUpstream({ kind: "none" });
          return;
        }
        if (entry.kind === "local") {
          // 无 target：Rust 读当前 kernelPort（ensureLocalReady 已就绪）。
          await setActiveUpstream({ kind: "local" });
          return;
        }
        // target 必须是规范化 http(s) 绝对基址；entry.baseURL 已在入册时规范化，这里再 fail-closed。
        await setActiveUpstream({
          kind: "remote",
          target: normalizeProbeBaseURL(entry.baseURL),
        });
      },
      async stopLocal() {
        await stopLocalCmd();
      },
      async startLocalOnly() {
        // 先探一次状态用于首 boot 判定（探测失败不阻塞启动，按结果回退判定）。
        const before = await localStatus().catch(() => null);
        const r = await startLocal();
        if (!r.ok) throw new Error(r.error);
        // 曾未添加 / 曾未初始化 = 首次初始化；before 不可得时以本次结果 initialized 反推。
        const firstBoot = before ? !before.added || !before.initialized : !r.initialized;
        return { firstBoot };
      },
      async stopLocalOnly() {
        await stopLocalCmd();
      },
    },
  };
}

/**
 * 浏览器单例（懒加载）。桌面 App 启动器 UI 与 S2 client 接线共用这一个仓库与同一个 resolver 单例。
 * 成品壳（hasShell + 门控开）装配 shellDefaultDeps；其余一切环境装配 browserDefaultDeps（现状）。
 */
export function getLauncherStore(overrides?: Partial<LauncherStoreDeps>): LauncherStore {
  if (browserSingleton) return browserSingleton;
  const storage = browserStorage();
  if (!storage) throw new Error("启动器仓库需要浏览器 localStorage 环境");
  const defaults =
    hasShell() && launcherEnabled() ? shellDefaultDeps() : browserDefaultDeps();
  browserSingleton = createLauncherStore({ storage, ...defaults, ...overrides });
  return browserSingleton;
}

/** 仅供测试重置浏览器单例。 */
export function __resetLauncherStoreForTest(): void {
  browserSingleton = null;
}
