// apps/web/src/node/launcherViewModel.ts
// 启动器节点列表的**纯派生层**（DESIGN-MACOS-APP.md §8.5 规则 #6 悬浮气泡 + 状态）。
//
// 把可持久化注册表（不含凭据/实时态）+ 已建立会话的远端用户，派生成 UI 直接可渲染的行模型。
// 纯函数、不碰 DOM/React，node 环境直测。实时健康（在线/连接中/离线/未启动）将来由
// Tauri command / 健康探测另提供，本层只表达注册表层面确定的状态（活动/期望态/是否已登录）。

import type { NodeRegistryState, StoredNodeEntry } from "./registry";
import { hasLocal, isPrimaryEntry, isReplicaEntry } from "./registry";
import { LOCAL_NODE_ID } from "./resolve";
import type { RemoteSessionView } from "./remoteSessions";

/**
 * 本地内核的实时运行相位（W2 四态）。仅壳内由 localStatus 轮询结果映射；
 * 非壳（浏览器/fnOS/服务器）行上该字段恒 undefined，状态文案走 localDesired 旧推导，行为零变化。
 */
export type LocalRuntimePhase = "unknown" | "absent" | "stopped" | "starting" | "ready";

/**
 * localStatus 的最小结构（不 import shellBridge，保持纯层无 DOM/壳依赖）。
 * 与 shellBridge.LocalStatus 字段同名同义：added=曾添加，initialized=数据已初始化，
 * running=进程在，ready=/readyz 绿，kernelPort=就绪端口（未就绪为 null）。
 */
export interface LocalRuntimeLike {
  added: boolean;
  initialized: boolean;
  running: boolean;
  ready: boolean;
  kernelPort: number | null;
}

/** 单个节点在列表里的展示模型。 */
export interface NodeRow {
  kind: "local" | "remote";
  /**
   * 本地侧角色（身份判别真源，勿再只看 kind——kind:"local" 同时涵盖主库与副本）：
   *   - "primary"：唯一本机主库（nodeId 恒 LOCAL_NODE_ID，不可删，承载 localDesired/实时 runtime）；
   *   - "replica"：离线副本（nodeId 为白名单副本名，baseURL 恒 ""，无 localDesired/runtime）；
   *   - null：远端节点（kind:"remote"）。
   */
  role: "primary" | "replica" | null;
  nodeId: string;
  /** 主标题：自定义名称优先；本地缺省「本机」，远端缺省取其 host。 */
  title: string;
  /** 原始自定义名（null＝用默认名）；重命名编辑框据此预填，清空保存即回落默认名。 */
  label: string | null;
  /** 副标题：远端显示完整基址；本地显示「本机数据」。 */
  subtitle: string;
  baseURL: string;
  /** 是否当前唯一活动节点（单活，DESIGN §10）。 */
  active: boolean;
  /** 远端是否已有有效会话（决定「连接」是免密直连还是要先登录）。 */
  connected: boolean;
  /** 已登录远端用户的展示名（邮箱/姓名），无则 null。 */
  account: string | null;
  /** 仅本地：下次启动是否期望内核运行；远端恒 null。 */
  localDesired: "running" | "stopped" | null;
  /** 本地条目永久不可删（戴总硬规则 #2）；远端可删。 */
  removable: boolean;
  /**
   * 是否允许行内重命名。注册表真实条目恒 true；
   * 仅面板为"从未初始化本机"合成的占位本机行为 false（尚未注册，无可改名实体）。
   */
  canRename: boolean;
  lastConnectedAt: string | null;
  /**
   * 仅本地行：壳内实时运行相位（由 applyLocalRuntime 从 localStatus 映射）。
   * 可选——非壳/未注入实时态时为 undefined，列表保持 localDesired 旧文案（零变化的关键）。
   * 远端行恒 undefined。
   */
  runtime?: LocalRuntimePhase;
  /** 仅本地行：实时内核端口（未就绪/未知为 null）；远端行恒缺省。 */
  kernelPort?: number | null;
}

/** 由绝对/相对基址取一个可读 host（远端缺省标题用）；失败回退原串。 */
export function hostLabel(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return baseURL;
  }
}

function userDisplay(view: RemoteSessionView | undefined): string | null {
  if (!view) return null;
  const u = view.user as { email?: unknown; name?: unknown } | null;
  if (u && typeof u.email === "string" && u.email) return u.email;
  if (u && typeof u.name === "string" && u.name) return u.name;
  return null;
}

function toRow(
  entry: StoredNodeEntry,
  activeNodeId: string | null,
  localDesired: NodeRegistryState["localDesired"],
  sessions: ReadonlyMap<string, RemoteSessionView>,
): NodeRow {
  const active = entry.nodeId === activeNodeId;
  if (isPrimaryEntry(entry)) {
    return {
      kind: "local",
      role: "primary",
      nodeId: LOCAL_NODE_ID,
      title: entry.label?.trim() || "本机",
      label: entry.label,
      subtitle: "本机数据",
      baseURL: "",
      active,
      connected: active,
      account: null,
      localDesired: localDesired ?? "running",
      removable: false,
      canRename: true,
      lastConnectedAt: entry.lastConnectedAt,
    };
  }
  if (isReplicaEntry(entry)) {
    // 副本是「壳口同源的本地侧车」：浏览器侧无独立会话，但它成为活动节点或壳内已为该 nodeId
    // 建立分键会话时，同样表达「已连通/可免密进入」。身份必须保留 entry.nodeId（P0：旧码在此
    // 硬编码 LOCAL_NODE_ID，会把所有副本行串成主库）。
    const replicaSession = sessions.get(entry.nodeId);
    return {
      kind: "local",
      role: "replica",
      nodeId: entry.nodeId,
      title: entry.label?.trim() || "本机副本",
      label: entry.label,
      subtitle: entry.replica?.remoteBaseUrl ?? "",
      baseURL: "",
      active,
      connected: active || Boolean(replicaSession),
      account: userDisplay(replicaSession),
      localDesired: null,
      removable: true,
      canRename: true,
      lastConnectedAt: entry.lastConnectedAt,
    };
  }
  const session = sessions.get(entry.nodeId);
  return {
    kind: "remote",
    role: null,
    nodeId: entry.nodeId,
    title: entry.label?.trim() || hostLabel(entry.baseURL) || entry.nodeId,
    label: entry.label,
    subtitle: entry.baseURL,
    baseURL: entry.baseURL,
    active,
    // 活动指针指向它即视为已连接；否则有已存会话也标「可免密重连」。
    connected: active || Boolean(session),
    account: userDisplay(session),
    localDesired: null,
    removable: true,
    canRename: true,
    lastConnectedAt: entry.lastConnectedAt,
  };
}

/**
 * 行排序的角色权重：本机主库 0（永远最前）、离线副本 1（主库之后、远端之前）、远端 2。
 * 角色以 registry 选择器为真源，不看 kind（kind:"local" 同时含主库与副本）。
 */
function rowOrderWeight(entry: StoredNodeEntry): number {
  if (isPrimaryEntry(entry)) return 0;
  if (isReplicaEntry(entry)) return 1;
  return 2;
}

/**
 * 派生节点列表行模型（稳定排序：主库 → 副本 → 远端；同角色内按最近连接时间倒序、从未连接垫底、
 * 再以 nodeId 兜底，保证次序确定）。不就地改入参。
 */
export function buildNodeRows(
  state: NodeRegistryState,
  sessions: ReadonlyMap<string, RemoteSessionView>,
): NodeRow[] {
  return [...state.entries]
    .sort((a, b) => {
      const weightDiff = rowOrderWeight(a) - rowOrderWeight(b);
      if (weightDiff !== 0) return weightDiff;
      if (a.lastConnectedAt && b.lastConnectedAt) {
        return a.lastConnectedAt < b.lastConnectedAt ? 1 : -1;
      }
      if (a.lastConnectedAt) return -1;
      if (b.lastConnectedAt) return 1;
      return a.nodeId < b.nodeId ? -1 : 1;
    })
    .map((e) => toRow(e, state.activeNodeId, state.localDesired, sessions));
}

/**
 * "从未初始化本机"的占位行（戴总交互硬规则：即便用户先直连了远端，切换页也要始终给一个
 * 启动/进入本机的入口）。注册表中并无 local 条目时由 {@link ensureLocalRow} 合成在列表最前。
 *
 * nodeId 仍为 LOCAL_NODE_ID：点击「进入本机/启动」走的 connectLocal/startLocal 会幂等自建
 * local 条目（addLocalNode），占位行随即被真实行取代。runtime 缺省为 undefined：
 *   - 壳内 applyLocalRuntime 据 localStatus(added=false) 映射为 "absent"（显「未启用 + 进入本机 + 启动」）；
 *   - 非壳/未注入实时态回落 unknown（单个「使用本机」旧形态，非壳零变化）。
 * canRename=false：占位实体尚未注册，不提供改名（避免对不存在的条目调 rename → NODE_NOT_FOUND）。
 */
export function placeholderLocalRow(): NodeRow {
  return {
    kind: "local",
    role: "primary",
    nodeId: LOCAL_NODE_ID,
    title: "本机",
    label: null,
    subtitle: "本机数据",
    baseURL: "",
    active: false,
    connected: false,
    account: null,
    localDesired: "stopped",
    removable: false,
    canRename: false,
    lastConnectedAt: null,
  };
}

/**
 * 保证展示行里始终存在本机行：已有真实 local 行则原样返回；否则在最前补一个占位本机行。
 * 纯函数、不改入参。仅用于面板**列表展示**——注册表为空的全新装仍走欢迎双 CTA（vm.isEmpty 不变），
 * 故此处只在"有远端、无本机"时真正产生差异，修复"直连远端后回不去/起不了本机"的交互缺口。
 */
export function ensureLocalRow(rows: readonly NodeRow[]): NodeRow[] {
  // 只认主库行：仅有副本（role:"replica"）时仍须补占位主库，保证「进入本机」入口恒在。
  if (rows.some((r) => r.role === "primary")) return [...rows];
  return [placeholderLocalRow(), ...rows];
}

/** 启动器整体视图状态：行列表 + 是否存在活动节点（决定进业务界面还是回连接界面）。 */
export interface LauncherViewModel {
  rows: NodeRow[];
  activeNodeId: string | null;
  hasActive: boolean;
  hasLocal: boolean;
  /** 全新安装：注册表为空（戴总硬规则 #1，直接进「添加节点」首屏）。 */
  isEmpty: boolean;
  /** 当前活动节点行（无活动为 null），供悬浮气泡等显示「当前在看哪个节点」。 */
  activeRow: NodeRow | null;
}

export function buildLauncherViewModel(
  state: NodeRegistryState,
  sessions: ReadonlyMap<string, RemoteSessionView>,
): LauncherViewModel {
  const rows = buildNodeRows(state, sessions);
  const activeNodeId = state.activeNodeId;
  return {
    rows,
    activeNodeId,
    hasActive: activeNodeId !== null,
    // 只认主库（registry 选择器真源）：仅有离线副本不算「已有本机主库」。
    hasLocal: hasLocal(state),
    isEmpty: state.entries.length === 0,
    activeRow: activeNodeId ? (rows.find((r) => r.nodeId === activeNodeId) ?? null) : null,
  };
}

/**
 * 单个本地状态 → 运行相位（applyLocalRuntime 的纯映射内核，便于表驱动单测）。
 * busyLocal 为点击瞬间的乐观态：除 ready 外一律展示 "starting"。
 */
export function localPhase(
  status: LocalRuntimeLike | null,
  busyLocal: boolean,
): LocalRuntimePhase {
  if (status === null) return "unknown";
  if (!status.added) return busyLocal ? "starting" : "absent";
  if (status.running && status.ready) return "ready";
  if (status.running && !status.ready) return "starting";
  // added && !running
  return busyLocal ? "starting" : "stopped";
}

/**
 * 把壳内 localStatus 实时探测结果映射到本地行的 runtime 相位（W2 四态）。
 *
 * 纯函数：返回**新数组**、不改入参；只作用于 role==="primary" 的本机主库行，副本行与远端行
 * 原样返回（引用可比，测试以 toBe 断言）。
 * status===null（壳内探测未回首拍 / 非壳未接线）→ 本地行 "unknown"，UI 回落 localDesired
 * 旧推导，保证 SSR 首拍与非壳形态零变化。
 */
export function applyLocalRuntime(
  rows: NodeRow[],
  status: LocalRuntimeLike | null,
  busyLocal: boolean,
): NodeRow[] {
  const phase = localPhase(status, busyLocal);
  const kernelPort = status?.kernelPort ?? null;
  let changed = false;
  const next = rows.map((row) => {
    // 实时相位只属于主库；副本行（kind:"local" 但 role:"replica"）与远端行一律原样返回。
    if (row.role !== "primary") return row;
    if (row.runtime === phase && row.kernelPort === kernelPort) return row;
    changed = true;
    return { ...row, runtime: phase, kernelPort };
  });
  return changed ? next : rows;
}
