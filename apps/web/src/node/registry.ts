// apps/web/src/node/registry.ts
// 启动器（Launcher）多节点模型——节点注册表纯逻辑层（DESIGN-MACOS-APP.md §8.5）。
//
// 与 S1 同口径：本模块**不碰 DOM / localStorage / Tauri**，只做「状态形状 + 纯变更 +
// 序列化解析 + 不变量」，持久化读写由 S2 运行时层（注入式 storage 适配）负责，node 环境可直接单测。
//
// 戴总 2026-10-16/17 拍板的硬规则在此固化为不变量：
//   1. 新装不启动本地节点——空注册表没有任何条目，自然不 boot/不初始化；
//   2. 本地节点全局唯一（kind=local 至多 1，nodeId 恒为 LOCAL_NODE_ID），添加后不可再建、不可删；
//   3. 本地节点「关闭」=进程优雅停止但数据保留——用 localDesired=stopped 表达「下次别拉起」，
//      条目本身仍在；再连只是 running，不重新初始化（是否已初始化由服务端 bootstrap-status 判定，不在本表）；
//   4. 远端节点可多个、可删；同一时刻只有一个活动节点（activeNodeId）；
//   5. 注册表**绝不存密码/token**（本地 token 走 gx-auth，各远端 JWT 由会话层按 nodeId 分键另存）。
//
// 本层只记「有哪些节点、各自的连接意图、当前看哪个」；每个节点的实时连接状态
// （在线/连接中/离线/未启动）来自运行时健康探测与 Tauri command，属另一层，不进可持久化状态。

import type { NodeKind } from "./datasource";
import { LOCAL_NODE_ID, normalizeNodeUrl } from "./resolve";

/** 副本 nodeId 长度上限（与 Rust sidecar.rs REPLICA_NODE_ID_MAX_LEN 同口径）。 */
const REPLICA_NODE_ID_MAX_LEN = 64;
/** 副本名白名单（与 Rust sanitize_node_id 同口径：字母/数字/点/下划线/连字符）。 */
const REPLICA_NODE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * 本地侧条目的角色：
 *   - primary：唯一本机主库（nodeId 恒 LOCAL_NODE_ID，至多一个、不可删）；
 *   - replica：可多个的离线副本（壳口同源的本地侧车，baseURL 恒 ""，nodeId 为副本白名单名）。
 * 缺省/任何非 "replica" 值一律按 primary 对待（version:1 老数据向后兼容）。
 */
export type NodeRole = "primary" | "replica";

/**
 * 副本绑定（仅 role:"replica" 条目使用）。
 * **安全铁律：不得含 token/密码字段。** remoteBaseUrl 仅用于展示/重绑，绝不参与浏览器 fetch
 * （副本流量走壳内 loopback，上游令牌只在 gx:start_replica 当次经 IPC 传给 Rust，注册表不存）。
 */
export interface ReplicaBinding {
  /**
   * 远端服务器规范化**裸 origin**（scheme://host[:port]，与 Rust upstream.rs normalize_http_base
   * 严格一致：丢弃 path/query/fragment 与内嵌凭证、无尾斜杠）。仅用于展示/重绑，绝不参与浏览器
   * fetch；同步服务器按根部署，用户误填的子路径在此被剥离。
   */
  remoteBaseUrl: string;
  clientId?: string | null;
  syncIntervalMs?: number | null;
}

/**
 * 注册表中的一个节点条目（持久化形状的最小集）。
 * 安全铁律：禁止在此加入 password / token / 任何凭据字段（DESIGN §8.2、§13.1）。
 */
export interface StoredNodeEntry {
  kind: NodeKind;
  /** 本地主库固定 LOCAL_NODE_ID；副本为白名单副本名；远端为规范化 baseURL 的 SHA-256 前 12 hex。 */
  nodeId: string;
  /** 本地主库/副本均为相对前缀 ""；远端为去尾斜杠绝对 baseURL。 */
  baseURL: string;
  label: string | null;
  /** 最近一次连接（成为活动节点）的 ISO 时间；从未连接为 null。 */
  lastConnectedAt: string | null;
  /** 仅 kind:"local" 有意义；缺省按 primary。 */
  role?: NodeRole;
  /** 仅 role:"replica" 用；主库/远端无此字段。 */
  replica?: ReplicaBinding | null;
}

/**
 * 启动器注册表持久化键（单份 JSON 信封：条目 + activeNodeId + localDesired）。
 * 与既有键全部不同：gx-auth(本地会话) / gx-node-session:*(远端会话) / gx-node-profiles(旧预留)。
 * 本形状只描述"有哪些节点/各自意图/当前看哪个"，不含任何凭据。
 */
export const LAUNCHER_REGISTRY_STORAGE_KEY = "gx-node-launcher";

/** 本地节点进程的「期望运行态」：跨重启记忆，决定壳下次是否自动拉起本地内核。 */
export type LocalDesiredState = "running" | "stopped";

/** 注册表持久化信封（version 便于将来演进）。 */
export interface NodeRegistryState {
  version: 1;
  entries: StoredNodeEntry[];
  /** 当前活动节点；无（启动器空态/全部断开）为 null。必须指向某个 entry。 */
  activeNodeId: string | null;
  /** 仅当本地节点已添加时有意义：running=下次自动拉起内核，stopped=保持停止。 */
  localDesired: LocalDesiredState | null;
}

export type RegistryErrorCode =
  | "LOCAL_PROFILE_EXISTS" // 已存在本地主库，禁止再建第二个
  | "LOCAL_PROFILE_PERMANENT" // 本地主库不可删除
  | "REMOTE_PROFILE_EXISTS" // 同 nodeId（同规范化基址）远端已在注册表
  | "REPLICA_PROFILE_EXISTS" // 同名副本 nodeId 已被任意条目占用
  | "REPLICA_ID_INVALID" // 副本名非法（空/超长/字符越界/路径穿越/占用 local）
  | "REPLICA_REMOTE_INVALID" // 副本远端基址无法规范化
  | "NODE_NOT_FOUND"; // 操作目标不存在于注册表

export interface RegistryError {
  code: RegistryErrorCode;
  message: string;
}

export interface RegistryResult {
  state: NodeRegistryState;
  error: RegistryError | null;
}

/** 空注册表＝全新安装：无任何节点、不启动本地内核、无活动节点（戴总 10-17 硬规则 #1）。 */
export function emptyRegistry(): NodeRegistryState {
  return { version: 1, entries: [], activeNodeId: null, localDesired: null };
}

function ok(state: NodeRegistryState): RegistryResult {
  return { state, error: null };
}
function fail(prev: NodeRegistryState, code: RegistryErrorCode, message: string): RegistryResult {
  return { state: prev, error: { code, message } };
}

// ── 选择器（纯读）─────────────────────────────────────────────────────────────

/** 是否为唯一本机主库：kind=local 且非 replica（缺省 role 一律按 primary）。 */
export function isPrimaryEntry(e: StoredNodeEntry): boolean {
  return e.kind === "local" && e.role !== "replica";
}

/** 是否为离线副本：kind=local 且显式 role=replica。 */
function isReplicaEntry(e: StoredNodeEntry): boolean {
  return e.kind === "local" && e.role === "replica";
}

export function getEntry(state: NodeRegistryState, nodeId: string): StoredNodeEntry | null {
  return state.entries.find((e) => e.nodeId === nodeId) ?? null;
}

/** 是否已有本机主库（只认 primary，副本不计）。 */
export function hasLocal(state: NodeRegistryState): boolean {
  return state.entries.some(isPrimaryEntry);
}

/** 本机主库条目（只认 primary，至多一个）；副本请用 replicaEntries。 */
export function localEntry(state: NodeRegistryState): StoredNodeEntry | null {
  return state.entries.find(isPrimaryEntry) ?? null;
}

/** 全部离线副本条目（kind=local + role=replica，可多个）。 */
export function replicaEntries(state: NodeRegistryState): StoredNodeEntry[] {
  return state.entries.filter(isReplicaEntry);
}

export function remoteEntries(state: NodeRegistryState): StoredNodeEntry[] {
  return state.entries.filter((e) => e.kind === "remote");
}

export function activeEntry(state: NodeRegistryState): StoredNodeEntry | null {
  return state.activeNodeId ? getEntry(state, state.activeNodeId) : null;
}

// ── 变更（纯函数：进一个状态，出一个新状态；不就地改入参）────────────────────────

/**
 * 添加（启用）本机主库。幂等失败而非异常：已存在主库 → LOCAL_PROFILE_EXISTS。
 * 添加本身只登记条目与「期望运行」，不自动成为活动节点（连接是独立动作 connectNode）。
 */
export function addLocalNode(state: NodeRegistryState): RegistryResult {
  if (hasLocal(state)) {
    return fail(state, "LOCAL_PROFILE_EXISTS", "本地节点已存在，不能创建第二个本地节点");
  }
  const entry: StoredNodeEntry = {
    kind: "local",
    role: "primary",
    nodeId: LOCAL_NODE_ID,
    baseURL: "",
    label: "本机",
    lastConnectedAt: null,
  };
  return ok({
    ...state,
    entries: [...state.entries, entry],
    localDesired: "running",
  });
}

/**
 * 校验副本 nodeId（与 Rust sidecar.rs sanitize_node_id 同口径）：
 *   - trim 后非空，长度 1..=64；
 *   - 仅 /^[A-Za-z0-9._-]+$/；
 *   - 不得整体为 "." 或 ".."；
 *   - 不得占用保留的本机主库 id（LOCAL_NODE_ID = "local"）。
 * 纯函数，不碰 DOM/storage/Tauri。
 */
export function isValidReplicaNodeId(name: string): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (trimmed.length > REPLICA_NODE_ID_MAX_LEN) return false;
  if (trimmed === "." || trimmed === "..") return false;
  if (trimmed === LOCAL_NODE_ID) return false;
  return REPLICA_NODE_ID_PATTERN.test(trimmed);
}

/**
 * 添加一个远端节点（nodeId/baseURL 已由 resolve 层规范化算出）。
 * 同 nodeId 已存在 → REMOTE_PROFILE_EXISTS。添加后不自动连接。
 */
export function addRemoteNode(
  state: NodeRegistryState,
  input: { nodeId: string; baseURL: string; label?: string | null },
): RegistryResult {
  if (getEntry(state, input.nodeId)) {
    return fail(state, "REMOTE_PROFILE_EXISTS", "该远端节点已在列表中");
  }
  const entry: StoredNodeEntry = {
    kind: "remote",
    nodeId: input.nodeId,
    baseURL: input.baseURL,
    label: input.label ?? null,
    lastConnectedAt: null,
  };
  return ok({ ...state, entries: [...state.entries, entry] });
}

/** addReplicaNode 入参。 */
export interface AddReplicaInput {
  /** 副本名（trim 后作为 nodeId，须过 isValidReplicaNodeId）。 */
  nodeId: string;
  label?: string | null;
  /** 远端服务器地址（用户输入；内部走 normalizeNodeUrl 取裸 origin 后存储）。 */
  remoteBaseUrl: string;
  clientId?: string | null;
  syncIntervalMs?: number | null;
}

/**
 * 添加一个离线副本条目（浏览器眼里是「壳口同源的本地侧车」：kind=local、baseURL 恒 ""）。
 *   - nodeId 非法 → REPLICA_ID_INVALID；
 *   - nodeId 已被任意条目（主库/副本/远端）占用 → REPLICA_PROFILE_EXISTS；
 *   - remoteBaseUrl 无法规范化 → REPLICA_REMOTE_INVALID；
 *     存下的是规范化**裸 origin**（normalized.origin = scheme://host[:port]，剥离用户误填的子路径，
 *     与 Rust upstream.rs normalize_http_base 同口径），仅供展示/重绑、绝不参与浏览器 fetch。
 * 添加后不自动连接。副本可多个、可删除，与唯一不可删的本机主库区分。
 */
export function addReplicaNode(
  state: NodeRegistryState,
  input: AddReplicaInput,
): RegistryResult {
  const name = input.nodeId.trim();
  if (!isValidReplicaNodeId(input.nodeId)) {
    return fail(state, "REPLICA_ID_INVALID", "副本节点名不合法");
  }
  if (getEntry(state, name)) {
    return fail(state, "REPLICA_PROFILE_EXISTS", "同名副本节点已存在");
  }
  const normalized = normalizeNodeUrl(input.remoteBaseUrl);
  if (!normalized) {
    return fail(state, "REPLICA_REMOTE_INVALID", "副本远端服务器地址不合法");
  }
  const entry: StoredNodeEntry = {
    kind: "local",
    role: "replica",
    nodeId: name,
    baseURL: "",
    label: input.label ?? null,
    lastConnectedAt: null,
    replica: {
      remoteBaseUrl: normalized.origin,
      clientId: input.clientId ?? null,
      syncIntervalMs: input.syncIntervalMs ?? null,
    },
  };
  return ok({ ...state, entries: [...state.entries, entry] });
}

/**
 * 删除节点：允许远端与离线副本；本机主库永久存在 → LOCAL_PROFILE_PERMANENT（戴总硬规则 #2）。
 * 若删的正是活动节点，活动态回落到 null（界面回启动器）。
 */
export function removeNode(state: NodeRegistryState, nodeId: string): RegistryResult {
  const entry = getEntry(state, nodeId);
  if (!entry) return fail(state, "NODE_NOT_FOUND", "节点不存在");
  if (isPrimaryEntry(entry)) {
    return fail(state, "LOCAL_PROFILE_PERMANENT", "本地节点不可删除，只能停止其运行");
  }
  return ok({
    ...state,
    entries: state.entries.filter((e) => e.nodeId !== nodeId),
    activeNodeId: state.activeNodeId === nodeId ? null : state.activeNodeId,
  });
}

/**
 * 连接某节点＝把它设为唯一活动节点（单活，DESIGN §10），并刷新 lastConnectedAt；
 * 连接**本机主库**（仅 primary）同时把期望运行态置 running（壳据此拉起主库内核）。
 * 离线副本的连接只改 activeNodeId/lastConnectedAt，**不动 localDesired**（副本起停由独立命令编排，
 * 且主库/副本内核互斥，不能让连副本篡改主库的跨重启期望态）。
 * 会话凭据注入 / queryClient.clear() / resolver 切换由运行时编排层在成功后执行，不在本层。
 */
export function connectNode(state: NodeRegistryState, nodeId: string, nowIso: string): RegistryResult {
  const entry = getEntry(state, nodeId);
  if (!entry) return fail(state, "NODE_NOT_FOUND", "节点不存在");
  const entries = state.entries.map((e) =>
    e.nodeId === nodeId ? { ...e, lastConnectedAt: nowIso } : e,
  );
  return ok({
    ...state,
    entries,
    activeNodeId: nodeId,
    localDesired: isPrimaryEntry(entry) ? "running" : state.localDesired,
  });
}

/**
 * 断开某节点。
 *  - 若它是当前活动节点，活动态置 null（回启动器，绝不保留指向已断开节点的活动指针）；
 *  - 断开**本机主库**（仅 primary）额外把期望运行态置 stopped（戴总硬规则 #3：手动关闭本地=停进程、
 *    释放占用、保留数据）；断离线副本不动 localDesired（副本停的是副本内核，与主库期望态无关）。
 * 远端会话凭据的清理（§8.3 token 清单）由会话层按 nodeId 执行，不在本层。
 */
export function disconnectNode(state: NodeRegistryState, nodeId: string): RegistryResult {
  const entry = getEntry(state, nodeId);
  if (!entry) return fail(state, "NODE_NOT_FOUND", "节点不存在");
  return ok({
    ...state,
    activeNodeId: state.activeNodeId === nodeId ? null : state.activeNodeId,
    localDesired: isPrimaryEntry(entry) ? "stopped" : state.localDesired,
  });
}

/** 仅重命名某节点标签（远端可改显示名；本地也允许自定义显示名）。 */
export function renameNode(
  state: NodeRegistryState,
  nodeId: string,
  label: string | null,
): RegistryResult {
  if (!getEntry(state, nodeId)) return fail(state, "NODE_NOT_FOUND", "节点不存在");
  return ok({
    ...state,
    entries: state.entries.map((e) => (e.nodeId === nodeId ? { ...e, label } : e)),
  });
}

// ── 持久化：序列化 / 宽容解析（fail-safe，宁回空册不抛异常炸首屏）──────────────────

/**
 * 序列化为 localStorage 字符串。**只挑白名单字段**：类型上就不含 token/password，
 * replica 绑定即使被误塞入凭据也无字段可落盘（测试再固化一次 JSON 不含 token/password）。
 * role 仅在显式存在时输出；replica 绑定仅在 role=replica 且有 binding 时输出。仍 version:1（老读取方宽容）。
 */
export function serializeRegistry(state: NodeRegistryState): string {
  return JSON.stringify({
    version: 1,
    activeNodeId: state.activeNodeId,
    localDesired: state.localDesired,
    entries: state.entries.map((e) => {
      const out: Record<string, unknown> = {
        kind: e.kind,
        nodeId: e.nodeId,
        baseURL: e.baseURL,
        label: e.label,
        lastConnectedAt: e.lastConnectedAt,
      };
      if (e.role !== undefined) out.role = e.role;
      if (e.role === "replica" && e.replica) {
        const binding: Record<string, unknown> = { remoteBaseUrl: e.replica.remoteBaseUrl };
        if (e.replica.clientId !== undefined && e.replica.clientId !== null) {
          binding.clientId = e.replica.clientId;
        }
        if (e.replica.syncIntervalMs !== undefined && e.replica.syncIntervalMs !== null) {
          binding.syncIntervalMs = e.replica.syncIntervalMs;
        }
        out.replica = binding;
      }
      return out;
    }),
  });
}

function isKind(v: unknown): v is NodeKind {
  return v === "local" || v === "remote";
}

/**
 * 宽容清洗一个持久化副本绑定：
 *   - 只挑白名单字段（remoteBaseUrl/clientId/syncIntervalMs），**任何 token/password 等额外键
 *     在此天然被丢弃**，绝不保留；
 *   - remoteBaseUrl 必须为非空字符串，否则视为无绑定（返回 null，条目仍按副本保留）；
 *     存的是**裸 origin**——过一遍 normalizeNodeUrl 取 .origin 做兜底收敛（剥离旧数据/手改里可能
 *     残留的子路径，与 Rust normalize_http_base 同口径）；万一规范化失败则保留原字符串，宁可展示
 *     原始值也不丢绑定（持久化值正常由 addReplicaNode 保证已为 origin）；
 *   - clientId 非字符串/为空 → 省略；syncIntervalMs 非有限数字 → 省略。
 */
function parseReplicaBinding(raw: unknown): ReplicaBinding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.remoteBaseUrl !== "string" || rec.remoteBaseUrl.trim() === "") return null;
  const normalized = normalizeNodeUrl(rec.remoteBaseUrl);
  const binding: ReplicaBinding = {
    remoteBaseUrl: normalized ? normalized.origin : rec.remoteBaseUrl,
  };
  if (typeof rec.clientId === "string" && rec.clientId.length > 0) {
    binding.clientId = rec.clientId;
  }
  if (typeof rec.syncIntervalMs === "number" && Number.isFinite(rec.syncIntervalMs)) {
    binding.syncIntervalMs = rec.syncIntervalMs;
  }
  return binding;
}

/**
 * 从持久化字符串恢复并**强制收敛不变量**（脏数据/老数据/手改都不能让注册表越界）：
 *  - 非法 JSON / 非对象 / version 不符 → 空册；
 *  - 丢弃形状不合法的条目；
 *  - 本机主库（kind=local 且 role!=replica，含无 role 老数据）至多一个且规范为 LOCAL_NODE_ID；
 *  - 离线副本（kind=local 且 role=replica）可多个：nodeId 须过白名单（trim 后非空、!==local、
 *    /^[A-Za-z0-9._-]+$/、长度≤64、非 "."/".."），baseURL 强制为 ""，按 nodeId 去重（保留首个），
 *    绑定只挑白名单字段、token/password 一律丢弃；
 *  - 远端条目照旧；nodeId 全局去重（保留首个）；
 *  - activeNodeId 若不指向任何存活条目（含副本 id）→ null；
 *  - localDesired 仅由「本机主库是否存在」决定：无主库→null；有主库且非合法枚举→running（默认拉起）。
 */
export function parseRegistry(raw: string | null | undefined): NodeRegistryState {
  if (typeof raw !== "string" || raw.trim() === "") return emptyRegistry();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyRegistry();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyRegistry();
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.entries)) return emptyRegistry();

  const seen = new Set<string>();
  let sawPrimary = false;
  const entries: StoredNodeEntry[] = [];
  for (const item of obj.entries) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (!isKind(rec.kind)) continue;
    if (typeof rec.nodeId !== "string" || !rec.nodeId) continue;
    if (typeof rec.baseURL !== "string") continue;

    if (rec.kind === "local" && rec.role === "replica") {
      // 离线副本：白名单校验（与 Rust sanitize_node_id 同口径），全局按 nodeId 去重。
      const name = rec.nodeId.trim();
      if (!isValidReplicaNodeId(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      entries.push({
        kind: "local",
        role: "replica",
        nodeId: name,
        baseURL: "", // 副本浏览器眼里壳口同源，baseURL 恒 ""
        label: typeof rec.label === "string" ? rec.label : null,
        lastConnectedAt: typeof rec.lastConnectedAt === "string" ? rec.lastConnectedAt : null,
        replica: parseReplicaBinding(rec.replica),
      });
    } else if (rec.kind === "local") {
      if (sawPrimary) continue; // 本机主库至多一个
      sawPrimary = true;
      if (seen.has(LOCAL_NODE_ID)) continue;
      seen.add(LOCAL_NODE_ID);
      entries.push({
        kind: "local",
        role: "primary",
        nodeId: LOCAL_NODE_ID,
        baseURL: "",
        label: typeof rec.label === "string" ? rec.label : "本机",
        lastConnectedAt: typeof rec.lastConnectedAt === "string" ? rec.lastConnectedAt : null,
      });
    } else {
      if (seen.has(rec.nodeId)) continue;
      seen.add(rec.nodeId);
      entries.push({
        kind: "remote",
        nodeId: rec.nodeId,
        baseURL: rec.baseURL,
        label: typeof rec.label === "string" ? rec.label : null,
        lastConnectedAt: typeof rec.lastConnectedAt === "string" ? rec.lastConnectedAt : null,
      });
    }
  }

  const activeOkay =
    typeof obj.activeNodeId === "string" && seen.has(obj.activeNodeId)
      ? obj.activeNodeId
      : null;

  let localDesired: LocalDesiredState | null = null;
  if (sawPrimary) {
    localDesired = obj.localDesired === "stopped" ? "stopped" : "running";
  }

  return { version: 1, entries, activeNodeId: activeOkay, localDesired };
}
