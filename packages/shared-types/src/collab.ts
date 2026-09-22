// packages/shared-types/src/collab.ts
// 批次 F 三类内容实时协同：前后端唯一契约真源（房间 / 票据 / presence / 控制消息 / 锁冲突）。
// 设计依据 docs/design/2026-09-collab/DESIGN.md §4。
//
// 纪律：
//   - 本文件只描述「协议形状」，不含任何 Yjs / 编辑器类型（服务端全程不 import 编辑器）。
//   - 二进制数据（Y.Doc 增量、awareness 载荷）不走本文件，直接是 Uint8Array 帧。

/** 协同内容类别。沿用既有词汇：kb_docs.kind 已区分 doc/canvas。 */
export type CollabKind = "doc" | "canvas" | "table";

/** 房间标识。roomId 恒定等于 `"<kind>:<objectId>"`。 */
export interface CollabRoomRef {
  kind: CollabKind;
  objectId: string;
}

/** 由房间引用生成 roomId（前后端必须共用，不得各自拼串）。 */
export function collabRoomId(ref: CollabRoomRef): string {
  return `${ref.kind}:${ref.objectId}`;
}

/** 解析 roomId；形状非法返回 null（服务端用作入参校验）。 */
export function parseCollabRoomId(roomId: string): CollabRoomRef | null {
  const i = roomId.indexOf(":");
  if (i <= 0 || i === roomId.length - 1) return null;
  const kind = roomId.slice(0, i);
  if (kind !== "doc" && kind !== "canvas" && kind !== "table") return null;
  return { kind, objectId: roomId.slice(i + 1) };
}

/** 连接的身份档位：登录用户 / 匿名访客（通过分享链接进入）。 */
export type CollabSubjectKind = "user" | "guest";

/** 连接的可写档位。viewer 的连接尝试写入 → 服务端 close(4403)。 */
export type CollabRole = "editor" | "viewer";

/** 单个协作者的光标位置（坐标模型不依赖编辑器内部 path）。 */
export type CollabSelection =
  | { kind: "doc"; blockId: string; offset: number; length: number }
  | { kind: "canvas"; elementIds: string[] }
  | { kind: "table"; rowId: string; fieldId: string | null };

/** 单元占用租约（§5.2：借 awareness 生命周期，不建独立存储）。 */
export interface CollabLease {
  /** 占用单元标识：doc=blockId，canvas=`${creatorClientId}:${plaitId}`，table=`${rowId}#${fieldId}`。 */
  unit: string;
  since: number;
  /** epoch ms；客户端续约失败即过期，服务端以 awareness 消失为准释放。 */
  expiresAt: number;
}

/** 在线名单条目（头像列表 + 光标渲染都用它）。 */
export interface CollabPresenceEntry {
  /**
   * 连接级唯一 id。服务端与客户端都取自 awareness 的 clientID（字符串形式），
   * 因此两端对同一连接得出的 id 一致；同一用户多标签页 = 多条。
   */
  id: string;
  kind: CollabSubjectKind;
  /** kind==='user' 时为其 userId；访客为 null。 */
  userId: string | null;
  /** 展示名：登录用户为昵称，访客恒为「匿名」。 */
  nick: string;
  /** 服务端分配的光标配色（#RRGGBB），客户端不得自行生成。 */
  color: string;
  selection: CollabSelection | null;
  leases: CollabLease[];
  role: CollabRole;
}

/** 断线/失败原因，也是服务端踢线的 reason 取值。 */
export type CollabDenyReason =
  | "ticket_invalid"
  | "ticket_expired"
  | "no_access"
  | "readonly"
  | "handshake_timeout"
  | "downgraded";

/** 私有关闭码段 4400–4499：客户端一律视为永久错误，停止重连。 */
export const COLLAB_CLOSE = {
  /** 无权限 / 票据无效或已核销。 */
  UNAUTHORIZED: 4401,
  /** 只读连接尝试写入。 */
  READONLY_WRITE: 4403,
  /** 握手超时（连接后未在窗口内完成初始化）。 */
  HANDSHAKE_TIMEOUT: 4408,
} as const;

/** 判定关闭码是否为「永久错误」（不重连）。 */
export function isPermanentCollabClose(code: number): boolean {
  return code >= 4400 && code <= 4499;
}

/** `GET /api/collab/ticket` 响应。票据 60s 有效、单次核销。 */
export interface CollabTicketResponse {
  ticket: string;
  roomId: string;
  /** epoch ms */
  expiresAt: number;
  role: CollabRole;
  kind: CollabSubjectKind;
  /** 服务端下发的主体 userId（访客为 null）。presence 里的 userId 一律以服务端下发为准，不由客户端自报。 */
  userId: string | null;
  /** 服务端分配，客户端首帧 awareness 直接采用。 */
  nick: string;
  color: string;
  /** 连接路径，如 `/ws/collab/doc%3Aabc`；前端自行拼 origin 与 `?t=`。 */
  wsPath: string;
  serverTime: number;
}

/** `GET /api/collab/presence` 响应：WS 未连上时的首屏兜底。 */
export interface CollabPresenceSnapshot {
  roomId: string;
  entries: CollabPresenceEntry[];
  serverTime: number;
}

/**
 * 服务端 → 客户端的控制消息。
 * 走 **WebSocket 文本帧**；Yjs 增量走二进制帧，两者互不混淆（服务端无需解析二进制）。
 */
export type CollabServerControlMessage =
  | { type: "revoked"; reason: CollabDenyReason; message: string }
  | { type: "peer_left"; id: string }
  | { type: "flushed"; contentVersion: number; at: number };

/** REST 侧的行级占用冲突（§3.5：数据表按行收口，409 必须可展示）。 */
export interface CollabRowLockConflict {
  error: "ROW_LOCKED";
  message: string;
  rowId: string;
  holder: { id: string; nick: string; kind: CollabSubjectKind };
  expiresAt: number;
}
