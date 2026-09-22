// apps/api/src/collab/index.ts
// 协同子系统的对外出口：装配入口 attachCollab + 优雅关闭收口 flushAllAndClose。
// 其余模块（房间/注册表/票据/presence）供路由与后续阶段按需 import。

import type { CollabPresenceEntry } from "@gx/shared-types";
import { attachCollab, closeAllCollabSockets } from "./attach.js";
import { registerDocFlusher } from "./docFlush.js";
import {
  beginShutdown,
  disposeAll,
  flushAllRooms,
  presenceOf,
  stopTimers,
} from "./registry.js";

// 冷归结实现的装配点：doc 的 flusher 在模块加载时注册进 room.ts 的注入点。
// 必须早于任何房间建立（房间只有经 attachCollab 的 WS 才会出现，而本模块正是它的出口）。
registerDocFlusher();

export { attachCollab };
export { registerDocFlusher, injectDocContent, flushDocRoom } from "./docFlush.js";
export { onlineRoom } from "./registry.js";
export { registerRoomFlusher } from "./room.js";
export { issueTicket } from "./tickets.js";
export type { CollabTicketPayload } from "./tickets.js";

/** presence 快照（HTTP 端点用）：房间没人在线时返回空数组。 */
export function getRoomPresence(roomId: string): CollabPresenceEntry[] {
  return presenceOf(roomId);
}

/**
 * 优雅关闭：清定时器 → 逐房间立即热持久化 → 断开所有 WS → 清空注册表。
 *
 * 顺序不可换：
 *   1) beginShutdown 让后续 close 事件不再触发「空置归结」（避免重复写）；
 *   2) 先 flush 再 close —— 让最后一段编辑落盘（R10），且关掉长连接后
 *      server.close() 才不会一直等在线连接；
 *   3) disposeAll 放在最后，销毁 Y.Doc 释放内存。
 */
export async function flushAllAndClose(): Promise<void> {
  beginShutdown();
  stopTimers();
  await flushAllRooms();
  closeAllCollabSockets();
  disposeAll();
}
