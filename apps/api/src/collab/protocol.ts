// apps/api/src/collab/protocol.ts
// y-protocols 线上帧的【消息码】与【帧头/awareness 载荷的最小解析】。
//
// 服务端只认四种消息码（DESIGN §4.2），全程不 import 任何编辑器实现：
//   0=sync / 1=awareness / 2=auth / 3=queryAwareness
// 文本帧一律忽略（服务端→客户端的控制消息才走文本帧，且是单向的）。
//
// 判定「这条 sync 帧是不是在写」必须读帧头的两个 varUint，不能用正则兜底兜
// （readonly-preview.ts:23-37 那套正则会误吞未知 op，设计文档 §11 已记过一次）。

import { createDecoder, readVarUint, readVarUint8Array, type Decoder } from "./codec.js";

export const MSG = {
  SYNC: 0,
  AWARENESS: 1,
  AUTH: 2,
  QUERY_AWARENESS: 3,
} as const;

/** sync 帧的子类型（紧跟 messageType 之后）。 */
export const SYNC_SUB = {
  STEP1: 0,
  STEP2: 1,
  UPDATE: 2,
} as const;

interface SyncFrameHead {
  messageType: number;
  /** 仅 messageType===SYNC 时有值；帧被截断时为 null。 */
  syncSubType: number | null;
}

/** 读帧头（不消费后续正文）：返回消息码与 sync 子类型；空帧/截断帧返回 null。 */
export function readFrameHead(bytes: Uint8Array): SyncFrameHead | null {
  const decoder = createDecoder(bytes);
  const messageType = readVarUint(decoder);
  if (messageType === null) return null;
  if (messageType !== MSG.SYNC) return { messageType, syncSubType: null };
  return { messageType, syncSubType: readVarUint(decoder) };
}

/**
 * 取 awareness 帧的载荷（跳过帧头的 messageType）。
 * 载荷形如：varUint(客户端数) + 每个客户端 { varUint(clientID), varUint(clock), varString(state) }。
 */
export function readAwarenessPayload(bytes: Uint8Array): Uint8Array | null {
  const decoder: Decoder = { arr: bytes, pos: 0 };
  if (readVarUint(decoder) === null) return null;
  return readVarUint8Array(decoder);
}

/**
 * 从 awareness 载荷里取出所有 clientID。
 *
 * 用途：presence 聚合要把「awareness 条目」映射回服务端权威的连接身份（role/nick/color
 * 由服务端在票据里发下去，不信客户端自报）。y-protocols 的 applyAwarenessUpdate 不返回
 * 它解析出了哪些 clientID，故在此按同样的线格读一遍——只读不写，解析失败即返回空数组
 * （最坏后果是 presence 少一条，不影响同步与持久化）。
 */
export function awarenessClientIds(payload: Uint8Array): number[] {
  const decoder = createDecoder(payload);
  const count = readVarUint(decoder);
  if (count === null || count < 0 || count > 4096) return [];
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const clientId = readVarUint(decoder);
    if (clientId === null) return ids;
    if (readVarUint(decoder) === null) return ids;
    if (readVarUint8Array(decoder) === null) return ids;
    ids.push(clientId);
  }
  return ids;
}
