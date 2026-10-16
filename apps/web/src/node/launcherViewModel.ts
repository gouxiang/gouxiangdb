// apps/web/src/node/launcherViewModel.ts
// 启动器节点列表的**纯派生层**（DESIGN-MACOS-APP.md §8.5 规则 #6 悬浮气泡 + 状态）。
//
// 把可持久化注册表（不含凭据/实时态）+ 已建立会话的远端用户，派生成 UI 直接可渲染的行模型。
// 纯函数、不碰 DOM/React，node 环境直测。实时健康（在线/连接中/离线/未启动）将来由
// Tauri command / 健康探测另提供，本层只表达注册表层面确定的状态（活动/期望态/是否已登录）。

import type { NodeRegistryState, StoredNodeEntry } from "./registry";
import { LOCAL_NODE_ID } from "./resolve";
import type { RemoteSessionView } from "./remoteSessions";

/** 单个节点在列表里的展示模型。 */
export interface NodeRow {
  kind: "local" | "remote";
  nodeId: string;
  /** 主标题：自定义名称优先；本地缺省「本机」，远端缺省取其 host。 */
  title: string;
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
  lastConnectedAt: string | null;
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
  if (entry.kind === "local") {
    return {
      kind: "local",
      nodeId: LOCAL_NODE_ID,
      title: entry.label?.trim() || "本机",
      subtitle: "本机数据",
      baseURL: "",
      active,
      connected: active,
      account: null,
      localDesired: localDesired ?? "running",
      removable: false,
      lastConnectedAt: entry.lastConnectedAt,
    };
  }
  const session = sessions.get(entry.nodeId);
  return {
    kind: "remote",
    nodeId: entry.nodeId,
    title: entry.label?.trim() || hostLabel(entry.baseURL) || entry.nodeId,
    subtitle: entry.baseURL,
    baseURL: entry.baseURL,
    active,
    // 活动指针指向它即视为已连接；否则有已存会话也标「可免密重连」。
    connected: active || Boolean(session),
    account: userDisplay(session),
    localDesired: null,
    removable: true,
    lastConnectedAt: entry.lastConnectedAt,
  };
}

/**
 * 派生节点列表行模型（稳定排序：本地在前，其后远端按最近连接时间倒序、从未连接垫底）。
 * 不就地改入参。
 */
export function buildNodeRows(
  state: NodeRegistryState,
  sessions: ReadonlyMap<string, RemoteSessionView>,
): NodeRow[] {
  return [...state.entries]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "local" ? -1 : 1;
      if (a.lastConnectedAt && b.lastConnectedAt) {
        return a.lastConnectedAt < b.lastConnectedAt ? 1 : -1;
      }
      if (a.lastConnectedAt) return -1;
      if (b.lastConnectedAt) return 1;
      return a.nodeId < b.nodeId ? -1 : 1;
    })
    .map((e) => toRow(e, state.activeNodeId, state.localDesired, sessions));
}

/** 启动器整体视图状态：行列表 + 是否存在活动节点（决定进业务界面还是回连接界面）。 */
export interface LauncherViewModel {
  rows: NodeRow[];
  activeNodeId: string | null;
  hasActive: boolean;
  hasLocal: boolean;
  /** 全新安装：注册表为空（戴总硬规则 #1，直接进「添加节点」首屏）。 */
  isEmpty: boolean;
}

export function buildLauncherViewModel(
  state: NodeRegistryState,
  sessions: ReadonlyMap<string, RemoteSessionView>,
): LauncherViewModel {
  return {
    rows: buildNodeRows(state, sessions),
    activeNodeId: state.activeNodeId,
    hasActive: state.activeNodeId !== null,
    hasLocal: state.entries.some((e) => e.kind === "local"),
    isEmpty: state.entries.length === 0,
  };
}
