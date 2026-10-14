// apps/web/src/node/session.ts
// 节点模式 S1（DESIGN §8.2）：双槽会话存储骨架。
//
// S1 只交付「键名常量 + 类型 + 纯函数」，刻意**不**在此第二处持久化本地 token：
//   - 本地槽就是现有 Zustand persist store（store/auth.ts），键名 `gx-auth`，形状/持久化方式
//     一律不变；本文件只固化键名常量与会话类型，读取仍走 useAuthStore（唯一真相源），
//     避免双写导致的 token 漂移。
//   - 远端槽 S1 为内存占位（模块级变量，恒 null）。档案持久化（gx-node-profiles）本阶段
//     不实现，仅预留键名常量与 TODO；S2 起才会真正使用远端会话槽。

import type { UserDTO } from "@gx/shared-types";
import { LOCAL_NODE_ID } from "./resolve";

/**
 * 本地会话槽 localStorage 键。
 * 必须与 store/auth.ts 的 persist `name` 完全一致（现状为 "gx-auth"）——此常量是那一字面量
 * 在节点域的唯一投影，S1 用测试锁定二者相等，防止后续误改造成两套键。
 */
export const LOCAL_SESSION_STORAGE_KEY = "gx-auth";

/**
 * 远端会话槽键（预留）。DESIGN §8.2 默认**仅内存**，不落 localStorage；只有未来开启
 * 「记住此连接（7 天）」时才会用此键持久化远端 token（S2+，本阶段不实现）。
 */
export const REMOTE_SESSION_STORAGE_KEY = "gx-node-session";

/**
 * 节点档案键（预留，S1 不实现持久化）。
 * 未来存 `NodeProfile[] = [{nodeId, baseURL, label, lastConnectedAt}]`，
 * **绝不存密码、不存 token**，仅用于免重输网址。
 */
export const NODE_PROFILES_STORAGE_KEY = "gx-node-profiles";

/** 会话槽标识：本地节点 / 远端节点，二者存储与缓存严格隔离。 */
export type SessionSlot = "local" | "remote";

/**
 * 一个节点会话（DESIGN §8.2 NodeSession）。
 *
 * 注意：local 槽在 localStorage 里的真实裸值是 zustand-persist 的信封
 * `{ "state": { token, user }, version?: number }`（由 store/auth.ts 写入），
 * **不是**本接口的裸形状。本接口描述节点域内部使用的会话视图，读取本地槽时由 store 投影得到。
 */
export interface NodeSession {
  /** "local" 或远端节点稳定 id。 */
  nodeId: string;
  /** local：同源相对前缀；remote：规范化绝对 baseURL。 */
  baseURL: string;
  /** 该槽位的 JWT；未登录为 null。 */
  token: string | null;
  /** 该槽位登录用户；未登录为 null。 */
  user: UserDTO | null;
}

/**
 * 节点档案（预留类型，S1 不持久化）。仅用于未来「最近连接」免重输网址。
 * 安全铁律：禁止在此加入 password / token 字段（DESIGN §8.2、§13.1）。
 */
export interface NodeProfile {
  nodeId: string;
  baseURL: string;
  label: string | null;
  lastConnectedAt: string | null;
}

/** 判定 nodeId 是否为本地槽。 */
export function isLocalNodeId(nodeId: string): boolean {
  return nodeId === LOCAL_NODE_ID;
}

/** 由 nodeId 反查会话槽：本地固定 id → local，其余一律 remote。 */
export function slotForNodeId(nodeId: string): SessionSlot {
  return isLocalNodeId(nodeId) ? "local" : "remote";
}

/**
 * 各会话槽对应的存储键。
 *
 * 注意远端槽在 S1 默认内存态，此键仅在未来「记住此连接」开启后才会真正落盘；
 * 这里集中映射是为了把「两槽绝不共用一个键」固化为可测的纯逻辑（见 session.test.ts）。
 */
export function storageKeyForSlot(slot: SessionSlot): string {
  return slot === "local" ? LOCAL_SESSION_STORAGE_KEY : REMOTE_SESSION_STORAGE_KEY;
}

/**
 * 隔离不变量（DESIGN §10.2）：两个同时持有的会话必须落在不同槽（nodeId 不同），
 * 否则意味着本地/远端会话发生了重叠/串槽。纯函数，供 S2 切换编排与测试固化。
 */
export function sessionsOccupyDistinctSlots(a: NodeSession, b: NodeSession): boolean {
  return a.nodeId !== b.nodeId;
}

/**
 * 远端会话槽（S1 内存占位，恒 null）。
 *
 * 模块级变量刻意不导出 setter：本阶段没有任何代码能写入远端会话，保证「恒 local」。
 * S2 的 connect.ts 会在本域内引入受控写入（登录成功后置入、断开/401 时按 §8.3 清空）。
 */
// 用 holder 容器而非裸 `let`：S1 没有任何代码能写入（getRemoteSession 恒返回 null），
// S2 的 connect.ts 会在**本域内**通过受控出口改写 holder.current（登录置入、断开/401 清空）。
const remoteSessionHolder: { current: NodeSession | null } = { current: null };

/** 读取远端会话槽；S1 恒为 null。 */
export function getRemoteSession(): NodeSession | null {
  return remoteSessionHolder.current;
}

// TODO(S2): 远端登录编排（node/connect.ts）——握手→向远端换 JWT→置 remoteSession；
//   断开/切换/401 执行 §8.3 清理清单并复位为 null。档案持久化（gx-node-profiles）
//   与「记住此连接（7 天）」在此之后按需开启，默认仍仅内存。
