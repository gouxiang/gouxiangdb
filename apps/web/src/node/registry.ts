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
import { LOCAL_NODE_ID } from "./resolve";

/**
 * 启动器注册表持久化键（单份 JSON 信封：条目 + activeNodeId + localDesired）。
 * 与既有键全部不同：gx-auth(本地会话) / gx-node-session:*(远端会话) / gx-node-profiles(旧预留)。
 * 本形状只描述"有哪些节点/各自意图/当前看哪个"，不含任何凭据。
 */
export const LAUNCHER_REGISTRY_STORAGE_KEY = "gx-node-launcher";

/** 本地节点进程的「期望运行态」：跨重启记忆，决定壳下次是否自动拉起本地内核。 */
export type LocalDesiredState = "running" | "stopped";

/**
 * 注册表中的一个节点条目（持久化形状的最小集）。
 * 安全铁律：禁止在此加入 password / token / 任何凭据字段（DESIGN §8.2、§13.1）。
 */
export interface StoredNodeEntry {
  kind: NodeKind;
  /** 本地固定 LOCAL_NODE_ID；远端为规范化 baseURL 的 SHA-256 前 12 hex。 */
  nodeId: string;
  /** 本地为相对前缀 ""；远端为去尾斜杠绝对 baseURL。 */
  baseURL: string;
  label: string | null;
  /** 最近一次连接（成为活动节点）的 ISO 时间；从未连接为 null。 */
  lastConnectedAt: string | null;
}

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
  | "LOCAL_PROFILE_EXISTS" // 已存在本地节点，禁止再建第二个
  | "LOCAL_PROFILE_PERMANENT" // 本地节点不可删除
  | "REMOTE_PROFILE_EXISTS" // 同 nodeId（同规范化基址）远端已在注册表
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

export function getEntry(state: NodeRegistryState, nodeId: string): StoredNodeEntry | null {
  return state.entries.find((e) => e.nodeId === nodeId) ?? null;
}

export function hasLocal(state: NodeRegistryState): boolean {
  return state.entries.some((e) => e.kind === "local");
}

export function localEntry(state: NodeRegistryState): StoredNodeEntry | null {
  return state.entries.find((e) => e.kind === "local") ?? null;
}

export function remoteEntries(state: NodeRegistryState): StoredNodeEntry[] {
  return state.entries.filter((e) => e.kind === "remote");
}

export function activeEntry(state: NodeRegistryState): StoredNodeEntry | null {
  return state.activeNodeId ? getEntry(state, state.activeNodeId) : null;
}

// ── 变更（纯函数：进一个状态，出一个新状态；不就地改入参）────────────────────────

/**
 * 添加（启用）本地节点。幂等失败而非异常：已存在本地节点 → LOCAL_PROFILE_EXISTS。
 * 添加本身只登记条目与「期望运行」，不自动成为活动节点（连接是独立动作 connectNode）。
 */
export function addLocalNode(state: NodeRegistryState): RegistryResult {
  if (hasLocal(state)) {
    return fail(state, "LOCAL_PROFILE_EXISTS", "本地节点已存在，不能创建第二个本地节点");
  }
  const entry: StoredNodeEntry = {
    kind: "local",
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

/**
 * 删除节点：仅允许远端。本地节点永久存在 → LOCAL_PROFILE_PERMANENT（戴总硬规则 #2）。
 * 若删的正是活动节点，活动态回落到 null（界面回启动器）。
 */
export function removeNode(state: NodeRegistryState, nodeId: string): RegistryResult {
  const entry = getEntry(state, nodeId);
  if (!entry) return fail(state, "NODE_NOT_FOUND", "节点不存在");
  if (entry.kind === "local") {
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
 * 连接本地节点同时把期望运行态置 running（壳据此拉起内核）。
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
    localDesired: entry.kind === "local" ? "running" : state.localDesired,
  });
}

/**
 * 断开某节点。
 *  - 若它是当前活动节点，活动态置 null（回启动器，绝不保留指向已断开节点的活动指针）；
 *  - 断开本地节点额外把期望运行态置 stopped（戴总硬规则 #3：手动关闭本地=停进程、释放占用、保留数据）。
 * 远端会话凭据的清理（§8.3 token 清单）由会话层按 nodeId 执行，不在本层。
 */
export function disconnectNode(state: NodeRegistryState, nodeId: string): RegistryResult {
  const entry = getEntry(state, nodeId);
  if (!entry) return fail(state, "NODE_NOT_FOUND", "节点不存在");
  return ok({
    ...state,
    activeNodeId: state.activeNodeId === nodeId ? null : state.activeNodeId,
    localDesired: entry.kind === "local" ? "stopped" : state.localDesired,
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

/** 序列化为 localStorage 字符串。本形状类型上就不含凭据，测试再固化一次。 */
export function serializeRegistry(state: NodeRegistryState): string {
  return JSON.stringify({
    version: 1,
    activeNodeId: state.activeNodeId,
    localDesired: state.localDesired,
    entries: state.entries.map((e) => ({
      kind: e.kind,
      nodeId: e.nodeId,
      baseURL: e.baseURL,
      label: e.label,
      lastConnectedAt: e.lastConnectedAt,
    })),
  });
}

function isKind(v: unknown): v is NodeKind {
  return v === "local" || v === "remote";
}

/**
 * 从持久化字符串恢复并**强制收敛不变量**（脏数据/老数据/手改都不能让注册表越界）：
 *  - 非法 JSON / 非对象 / version 不符 → 空册；
 *  - 丢弃形状不合法的条目；本地条目最多保留一个且规范为 LOCAL_NODE_ID；
 *  - nodeId 去重（保留首个）；本地条目的 baseURL 恒为 ""；
 *  - activeNodeId 若不指向任何存活条目 → null；
 *  - localDesired 与本地条目存在性对齐：无本地→null；有本地且非合法枚举→running（默认拉起，更安全）。
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
  let sawLocal = false;
  const entries: StoredNodeEntry[] = [];
  for (const item of obj.entries) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (!isKind(rec.kind)) continue;
    if (typeof rec.nodeId !== "string" || !rec.nodeId) continue;
    if (typeof rec.baseURL !== "string") continue;

    if (rec.kind === "local") {
      if (sawLocal) continue; // 本地至多一个
      sawLocal = true;
      if (seen.has(LOCAL_NODE_ID)) continue;
      seen.add(LOCAL_NODE_ID);
      entries.push({
        kind: "local",
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
  if (sawLocal) {
    localDesired = obj.localDesired === "stopped" ? "stopped" : "running";
  }

  return { version: 1, entries, activeNodeId: activeOkay, localDesired };
}
