// apps/web/src/node/remoteSessions.ts
// 启动器多节点——远端会话凭据层（DESIGN-MACOS-APP.md §8.5；主设计 §8.2 的多节点扩展）。
//
// 职责边界（重要）：
//   - 本地节点的 token/user 真相源**永远**是 zustand persist 的 `gx-auth`（store/auth.ts），
//     本模块**绝不**读写本地节点，也不提供第二个本地真相源（防止 token 漂移）。
//   - 每个**远端**节点各存一份会话（JWT + user），按 nodeId 分键，切走保留、切回免登录；
//     绝不存明文密码（DESIGN §8.2/§13.1）。远端 JWT 落 localStorage 是戴总 10-16 拍板
//     「记住选择、各记各账号、切回免登」的要求，与本地 gx-auth 同存储形态、同风险口径。
//
// 结构：纯函数 map 核心（无 DOM，node 可直接测）+ 薄存储适配（注入 Storage，生产用 localStorage）。

import type { UserDTO } from "@gx/shared-types";
import { isLocalNodeId } from "./session";

/** 远端会话分键前缀；与 session.ts 的单槽预留常量同源，多节点按 nodeId 追加。 */
export const REMOTE_SESSION_KEY_PREFIX = "gx-node-session";

/** 一个远端节点的登录会话（无密码）。 */
export interface RemoteSessionView {
  nodeId: string;
  token: string;
  user: UserDTO | null;
}

/** 持久化信封（version 便于演进）。 */
interface PersistedEnvelope {
  version: 1;
  token: string;
  user: UserDTO | null;
}

/** 最小存储接口（localStorage / 内存 fake 都满足）。 */
export interface KvStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 远端会话键：gx-node-session:&lt;nodeId&gt;。nodeId 非法（含 local）抛错。 */
export function remoteSessionKey(nodeId: string): string {
  if (typeof nodeId !== "string" || !nodeId) throw new Error("invalid nodeId");
  if (isLocalNodeId(nodeId)) {
    throw new Error("本地节点会话归 gx-auth，不进远端会话存储");
  }
  return `${REMOTE_SESSION_KEY_PREFIX}:${nodeId}`;
}

function toEnvelope(view: RemoteSessionView): PersistedEnvelope {
  return { version: 1, token: view.token, user: view.user };
}

/** 宽容解析单个会话；任何脏数据 → null（fail-closed，宁要重登不用残凭据）。 */
export function parseRemoteSession(nodeId: string, raw: string | null): RemoteSessionView | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1 || typeof obj.token !== "string" || !obj.token) return null;
  const user = (obj.user ?? null) as UserDTO | null;
  return { nodeId, token: obj.token, user };
}

/** 读某远端节点会话；不存在/脏 → null。绝不用于 local。 */
export function readRemoteSession(storage: KvStorage, nodeId: string): RemoteSessionView | null {
  return parseRemoteSession(nodeId, storage.getItem(remoteSessionKey(nodeId)));
}

/** 写某远端节点会话（登录成功/刷新后）。拒绝 local。返回写入后的视图。 */
export function writeRemoteSession(
  storage: KvStorage,
  view: RemoteSessionView,
): RemoteSessionView {
  if (isLocalNodeId(view.nodeId)) {
    throw new Error("本地节点会话归 gx-auth，禁止写入远端会话存储");
  }
  if (!view.token) throw new Error("拒绝写入空 token 会话");
  storage.setItem(remoteSessionKey(view.nodeId), JSON.stringify(toEnvelope(view)));
  return view;
}

/** 清除某远端节点会话（断开连接 / 删除节点 / 401，对应主设计 §8.3 token 清理）。 */
export function clearRemoteSession(storage: KvStorage, nodeId: string): void {
  storage.removeItem(remoteSessionKey(nodeId));
}

/**
 * 枚举存储里全部远端会话（供启动器恢复 / 退出登录时清点）。
 * 调用方提供当前已知远端 nodeId 列表；只解析这些分键，避免扫描整个 localStorage。
 */
export function readAllRemoteSessions(
  storage: KvStorage,
  remoteNodeIds: readonly string[],
): RemoteSessionView[] {
  const out: RemoteSessionView[] = [];
  for (const nodeId of remoteNodeIds) {
    if (isLocalNodeId(nodeId)) continue;
    const v = readRemoteSession(storage, nodeId);
    if (v) out.push(v);
  }
  return out;
}

/** 清除给定的全部远端会话（切换账号/全局登出）。本地 gx-auth 不受影响。 */
export function clearAllRemoteSessions(storage: KvStorage, remoteNodeIds: readonly string[]): void {
  for (const nodeId of remoteNodeIds) {
    if (isLocalNodeId(nodeId)) continue;
    storage.removeItem(remoteSessionKey(nodeId));
  }
}
