// apps/web/src/node/addRemoteFlow.ts
// 启动器「添加并连接一个远端节点」的交互编排（DESIGN-MACOS-APP.md §8.5 规则 #4；主设计 §7）。
//
// 一次用户提交（网址 + 账号 + 密码 + 可选名称）走完：
//   规范化网址 → 校验凭据 → 派生 nodeId → 注册表查重 → 三探针握手 → 入册 → 带凭据连接（登录换 JWT）
// 失败在每个阶段都收口为确定分类 AddNodeErrorKind（UI 用 nodeMessages 映射 §7.3 文案）。
//
// 安全 / 数据纪律：
//   - 密码只作为参数在内存里透传给 store.connectRemote，本函数不持久化、不写入注册表、不打日志；
//   - fail-closed：网址非法 / 连不上 / 不是节点 / 版本不兼容 / 远端未初始化，一律不建条目、不切换；
//   - 若已入册但随后登录失败，**回滚**刚加入的残条目，保证注册表不残留一个连不上的空节点；
//   - 纯逻辑、网络与哈希均可注入，node 环境直测，不依赖 React/DOM，不被任何现网入口 import。

import {
  normalizeNodeUrl,
  nodeIdFromBaseURL,
  type StringHasher,
} from "./resolve";
import {
  handshakeNode,
  HandshakeError,
  RemoteLoginError,
  type NodeHandshake,
} from "./handshake";
import type { NodeRegistryState, StoredNodeEntry } from "./registry";
import type { SwitchOutcome, RemoteCredentials } from "./launcher";
import type { AddNodeErrorKind, AddNodeFormErrorCode } from "./nodeMessages";

/** 编排器对启动器仓库所需的最小面（LauncherStore 结构上满足，测试可给 fake）。 */
export interface AddRemoteStorePort {
  getState(): NodeRegistryState;
  addRemote(input: { nodeId: string; baseURL: string; label?: string | null }): void;
  connectRemote(nodeId: string, creds?: RemoteCredentials): Promise<SwitchOutcome>;
  removeRemote(nodeId: string): void;
  /**
   * 成品壳专用：probe 同源转发握手工厂（begin_probe→/__gx/probe/<id>→end_probe）。
   * 浏览器/fnOS 的 store 无此方法（undefined）→ 编排器回落对显式 baseURL 直连握手（现状零变化）。
   */
  addHandshake?: (
    minNodeVersion?: string,
  ) => (baseURL: string) => Promise<NodeHandshake>;
}

export interface AddRemoteInput {
  /** 用户手输的节点网址（裸 host:port 或完整 http(s)://…[/basePath]）。 */
  url: string;
  email: string;
  /** 密码不做 trim（首尾空格理论上可能是密码的一部分），只判空。 */
  password: string;
  /** 可选显示名；空白等价于不填。 */
  label?: string | null;
}

export interface AddRemoteDeps {
  store: AddRemoteStorePort;
  /** 三探针握手；缺省用 handshakeNode 对显式 baseURL 直连（不经当前活动源）。 */
  performHandshake?: (baseURL: string) => Promise<NodeHandshake>;
  /** nodeId 派生；缺省 SubtleCrypto SHA-256 前 12 hex，测试注入确定性哈希。 */
  nodeIdFor?: (baseURL: string) => Promise<string>;
  /** 瘦客户端所测最低兼容节点版本（同 major 且 >= 此版本）；缺省仅要求版本可解析。 */
  minNodeVersion?: string;
}

export type AddRemoteResult =
  | {
      kind: "connected";
      nodeId: string;
      baseURL: string;
      /** 规范化后的（去尾斜杠、补协议）基址，供 UI 回显。 */
      handshake: NodeHandshake;
      outcome: SwitchOutcome;
    }
  | { kind: "error"; error: AddNodeErrorKind };

function formFail(code: AddNodeFormErrorCode): AddRemoteResult {
  return { kind: "error", error: { stage: "form", code } };
}

/**
 * 规范化节点显示名（添加节点与重命名共用的唯一口径）：
 * 空白/纯空格 → null（表示回落到默认名：本地「本机」/远端 host），否则去首尾空格。
 */
export function normalizeNodeLabel(label: string | null | undefined): string | null {
  if (label == null) return null;
  const t = label.trim();
  return t === "" ? null : t;
}

/**
 * 执行「添加并连接远端节点」。绝不静默回落本机；任何失败都不改变当前活动数据源。
 */
export async function addAndConnectRemote(
  input: AddRemoteInput,
  deps: AddRemoteDeps,
): Promise<AddRemoteResult> {
  // 1) 网址规范化（补协议 / host 小写 / 去尾斜杠 / 拒绝非法 host）。
  const normalized = normalizeNodeUrl(input.url);
  if (!normalized) return formFail("invalid_url");

  // 2) 凭据本地校验（在发出任何网络请求之前，避免白等探活）。邮箱去空格，密码只判空。
  const email = input.email.trim();
  if (!email || input.password === "") return formFail("missing_credentials");

  const label = normalizeNodeLabel(input.label);

  // 3) 派生稳定 nodeId。
  const nodeIdFor = deps.nodeIdFor ?? nodeIdFromBaseURL;
  const nodeId = await nodeIdFor(normalized.baseURL);

  // 4) 注册表查重（同规范化基址 = 同 nodeId）；已在列表则引导直接连接，不重复握手。
  if (deps.store.getState().entries.some((e: StoredNodeEntry) => e.nodeId === nodeId)) {
    return formFail("duplicate");
  }

  // 5) 三探针握手（匿名、对显式 baseURL）。分类错误直接返回，尚未入册、无污染。
  const performHandshake =
    deps.performHandshake ??
    ((baseURL: string) => handshakeNode({ baseURL, minNodeVersion: deps.minNodeVersion }));
  let handshake: NodeHandshake;
  try {
    handshake = await performHandshake(normalized.baseURL);
  } catch (err) {
    if (err instanceof HandshakeError) {
      return { kind: "error", error: { stage: "handshake", code: err.code } };
    }
    // 未预期的错误：按不可达 fail-closed，不泄露内部细节到 UI。
    return { kind: "error", error: { stage: "handshake", code: "unreachable" } };
  }

  // 6) 入册（此时尚未连接，条目存在但无活动指针）。
  deps.store.addRemote({ nodeId, baseURL: normalized.baseURL, label });

  // 7) 带当次凭据连接：内部对该节点登录换 JWT、写远端会话、切活动数据源。
  const creds: RemoteCredentials = { email, password: input.password };
  let outcome: SwitchOutcome;
  try {
    outcome = await deps.store.connectRemote(nodeId, creds);
  } catch (err) {
    // 登录失败 → 回滚第 6 步刚加入的残条目（removeRemote 对缺失条目幂等）。
    deps.store.removeRemote(nodeId);
    if (err instanceof RemoteLoginError) {
      return { kind: "error", error: { stage: "login", code: err.code } };
    }
    return { kind: "error", error: { stage: "login", code: "error" } };
  }

  return { kind: "connected", nodeId, baseURL: normalized.baseURL, handshake, outcome };
}

/** 「只选路」添加节点的入参：只要网址 + 可选名称，不收账号密码。 */
export interface RouteRemoteInput {
  /** 用户手输的节点网址（裸 host:port 或完整 http(s)://…[/basePath]）。 */
  url: string;
  /** 可选显示名；空白等价于不填。 */
  label?: string | null;
}

export type RouteRemoteResult =
  | {
      kind: "routed";
      nodeId: string;
      baseURL: string;
      /** 匿名握手画像（供 UI 展示版本等）。 */
      handshake: NodeHandshake;
      outcome: SwitchOutcome;
    }
  | { kind: "error"; error: AddNodeErrorKind };

/**
 * 执行「添加并进入远端节点」纯选路编排（2026-10「连接＝只选路」）。
 *
 * 与 addAndConnectRemote 的差别：**不收集、不校验、不发送任何账号密码，不发登录请求**。
 * 走完：规范化网址 → 派生 nodeId → 注册表查重 → 匿名三探针握手（远端空库 not_initialized
 * 仍 fail-closed）→ 入册 → connectRemote 纯选路（无会话即激活 token=null 的 remote-empty，
 * 壳上游切到该远端，界面随即展示该远端节点自己的登录页）。connectRemote/壳上游切换若失败，
 * 回滚刚加入的残条目；绝不静默回落本机、绝不改当前活动数据源（失败时）。
 */
export async function addAndRouteRemote(
  input: RouteRemoteInput,
  deps: AddRemoteDeps,
): Promise<RouteRemoteResult> {
  // 1) 网址规范化（补协议 / host 小写 / 去尾斜杠 / 拒绝非法 host）。
  const normalized = normalizeNodeUrl(input.url);
  if (!normalized) return { kind: "error", error: { stage: "form", code: "invalid_url" } };

  const label = normalizeNodeLabel(input.label);

  // 2) 派生稳定 nodeId。
  const nodeIdFor = deps.nodeIdFor ?? nodeIdFromBaseURL;
  const nodeId = await nodeIdFor(normalized.baseURL);

  // 3) 注册表查重（同规范化基址 = 同 nodeId）；已在列表则引导直接连接，不重复握手。
  if (deps.store.getState().entries.some((e: StoredNodeEntry) => e.nodeId === nodeId)) {
    return { kind: "error", error: { stage: "form", code: "duplicate" } };
  }

  // 4) 匿名三探针握手（对显式 baseURL）。分类错误直接返回，尚未入册、无污染；
  //    远端空库 not_initialized 在握手层即 fail-closed（瘦客户端不承接远端自举）。
  const performHandshake =
    deps.performHandshake ??
    ((baseURL: string) => handshakeNode({ baseURL, minNodeVersion: deps.minNodeVersion }));
  let handshake: NodeHandshake;
  try {
    handshake = await performHandshake(normalized.baseURL);
  } catch (err) {
    if (err instanceof HandshakeError) {
      return { kind: "error", error: { stage: "handshake", code: err.code } };
    }
    return { kind: "error", error: { stage: "handshake", code: "unreachable" } };
  }

  // 5) 入册（无活动指针变更前，条目先存在）。
  deps.store.addRemote({ nodeId, baseURL: normalized.baseURL, label });

  // 6) 纯选路：不传凭据，不登录。有记住的会话则带 JWT 直接进；无会话激活 remote-empty，
  //    壳上游切到该远端，用户随即看到该远端自己的登录页。
  let outcome: SwitchOutcome;
  try {
    outcome = await deps.store.connectRemote(nodeId);
  } catch {
    // 选路/壳上游切换失败 → 回滚第 5 步残条目（removeRemote 对缺失条目幂等）。
    deps.store.removeRemote(nodeId);
    // 纯选路无登录环节，统一收口为握手后不可达类错误，不暴露内部细节。
    return { kind: "error", error: { stage: "handshake", code: "unreachable" } };
  }

  return { kind: "routed", nodeId, baseURL: normalized.baseURL, handshake, outcome };
}

// 重新导出哈希类型，便于装配处/测试在不直接依赖 resolve 的情况下引用。
export type { StringHasher };

/** 连接「已在注册表」的远端节点所需的最小仓库面（LauncherStore 结构上满足）。 */
export interface ConnectExistingPort {
  getNode(nodeId: string): { kind: "local" | "remote" } | null;
  connectRemote(nodeId: string, creds?: RemoteCredentials): Promise<SwitchOutcome>;
}

/**
 * 成品壳模式的凭据重连端口：与「直连控制器」唯一的差别是 connectRemote 改走 **store**，
 * 使切换成功后触发壳代理 set_active_upstream（直连控制器不经过 store 的壳副作用包装）。
 * getNode 仍读控制器（纯注册表查询）。非壳不使用本适配器，UI 继续直传 controller，时序零变化。
 */
export function shellConnectPort(store: {
  controller: ConnectExistingPort;
  connectRemote(nodeId: string, creds?: RemoteCredentials): Promise<SwitchOutcome>;
}): ConnectExistingPort {
  return {
    getNode: (nodeId) => store.controller.getNode(nodeId),
    connectRemote: (nodeId, creds) => store.connectRemote(nodeId, creds),
  };
}

export interface ConnectExistingInput {
  nodeId: string;
  email: string;
  password: string;
}

export type ConnectExistingResult =
  | { kind: "connected"; nodeId: string; outcome: SwitchOutcome }
  | { kind: "error"; error: AddNodeErrorKind };

/**
 * 对已注册但当前无有效会话（从未登录 / 已断开 / 401 被踢）的远端节点，带当次凭据登录并连接。
 * 与 addAndConnectRemote 的区别：不规范化网址、不握手、不入册（条目已存在），只走登录换 JWT。
 * 有有效会话的免密重连应直接调 store.connectRemote(nodeId)，不经本函数。
 * 密码同样只在内存透传，不持久化。
 */
export async function connectExistingRemote(
  input: ConnectExistingInput,
  port: ConnectExistingPort,
): Promise<ConnectExistingResult> {
  const entry = port.getNode(input.nodeId);
  if (!entry || entry.kind !== "remote") {
    return { kind: "error", error: { stage: "form", code: "node_not_found" } };
  }
  const email = input.email.trim();
  if (!email || input.password === "") {
    return { kind: "error", error: { stage: "form", code: "missing_credentials" } };
  }
  try {
    const outcome = await port.connectRemote(input.nodeId, {
      email,
      password: input.password,
    });
    return { kind: "connected", nodeId: input.nodeId, outcome };
  } catch (err) {
    if (err instanceof RemoteLoginError) {
      return { kind: "error", error: { stage: "login", code: err.code } };
    }
    return { kind: "error", error: { stage: "login", code: "error" } };
  }
}
