// apps/api/src/collab/registry.ts
// 房间注册表：roomId → CollabRoom 的唯一持有者，外加冷归结的兜底节拍与优雅关闭收口。
//
// 两条硬规矩（DESIGN §2.3 / §3.7）：
//   1) 30s 兜底归结必须是【单个全局定时器】，且必须过 dirty 门 —— 每房间一个定时器会让
//      空闲房间也周期性触发归结，等于把 §1.5 的全库 nav 对账放大成常驻负载（R5）。
//   2) 房间空置（连接集合清空）立即归结一次 —— 这是「最后一人离开即落盘」的保证（R10）。

import { parseCollabRoomId, type CollabPresenceEntry, type CollabRoomRef } from "@gx/shared-types";
import { prisma } from "../db.js";
import { CollabRoom, type CollabConn } from "./room.js";
import { loadCollabState } from "./store.js";

/** 长会话兜底归结间隔（§12-A1：30s；且不得 < 1.2s）。 */
export const COLD_FLUSH_TICK_MS = 30_000;

const rooms = new Map<string, CollabRoom>();
/** 并发首次进入同一房间时只建一次（避免两个连接各建一个 Y.Doc 互相覆盖）。 */
const creating = new Map<string, Promise<CollabRoom | null>>();

let tick: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

/**
 * 取（或建）一个房间。
 * 返回 null 的三种情形：roomId 形状非法、kind 不是阶段 1 支持的 doc/canvas、
 * 目标对象不存在或 kind 不自洽 —— 调用方一律按「无权」处理（close 4401）。
 */
export async function acquireRoom(roomId: string): Promise<CollabRoom | null> {
  const ref = parseCollabRoomId(roomId);
  // 阶段 3 才接数据表：table 房间不建 = 不产生 collab_docs 行，也不占内存。
  if (!ref || ref.kind === "table") return null;
  const existing = rooms.get(roomId);
  if (existing) return existing;
  const inflight = creating.get(roomId);
  if (inflight) return await inflight;
  const task = createRoom(roomId, ref).finally(() => {
    creating.delete(roomId);
  });
  creating.set(roomId, task);
  return await task;
}

async function createRoom(roomId: string, ref: CollabRoomRef): Promise<CollabRoom | null> {
  const doc = await prisma.kbDoc.findFirst({
    where: { id: ref.objectId, deletedAt: null },
    // content 与 contentVersion 必须同一次读：两者共同构成冷归结三方归并的基线（base）。
    select: { id: true, kind: true, contentVersion: true, content: true },
  });
  if (!doc) return null;
  // kind 必须自洽：roomId 说 doc 而库里是 canvas 的房间一律不建（防跨类串房串内容）。
  if (doc.kind !== ref.kind) return null;

  const saved = await loadCollabState(roomId);
  const room = new CollabRoom({
    roomId,
    kind: ref.kind,
    initialState: saved.state,
    // base_version 取房间建立时的 contentVersion（table 房间为 null）。
    baseVersion: doc.contentVersion,
    baseContent: doc.content,
  });
  rooms.set(roomId, room);
  ensureTick();
  return room;
}

/**
 * 连接断开：先摘连接，空置则立即归结一次并销毁房间。
 * 销毁不丢内容 —— 归结已把状态写进 collab_docs，下次进入从库里读回（收敛）。
 */
export function releaseConn(room: CollabRoom, conn: CollabConn): void {
  const empty = room.removeConn(conn);
  if (!empty || shuttingDown) return;
  void (async () => {
    await room.flush("empty");
    // 归结期间可能有新连接进来：再判一次，非空就不销毁。
    if (room.conns.size === 0 && rooms.get(room.roomId) === room) {
      rooms.delete(room.roomId);
      room.destroy();
    }
  })();
}

function ensureTick(): void {
  if (tick) return;
  tick = setInterval(() => {
    void tickFlush();
  }, COLD_FLUSH_TICK_MS);
  tick.unref();
}

async function tickFlush(): Promise<void> {
  if (shuttingDown) return;
  for (const room of [...rooms.values()]) {
    // 冷门（不是 dirty）：dirty 会被 500ms 热持久化清掉，拿它当门会让长会话永不归结。
    if (!room.coldDirty) continue;
    await room.flush("tick");
  }
}

/** 房间是否存在（不管有没有人在线）。 */
export function roomOf(roomId: string): CollabRoom | undefined {
  return rooms.get(roomId);
}

/**
 * 房间**有人在线**才返回它（DESIGN §3.3 的闸门：房间在线时整篇覆盖写必须走 CRDT 注入，
 * 不再直接写库；没人在线才退回直接写库）。房间不存在或已空置 -> null。
 */
export function onlineRoom(roomId: string): CollabRoom | null {
  const room = rooms.get(roomId);
  return room && room.conns.size > 0 ? room : null;
}

/** presence 快照；房间不存在（没人在线）返回空数组。 */
export function presenceOf(roomId: string): CollabPresenceEntry[] {
  return rooms.get(roomId)?.presence() ?? [];
}

/** 当前全部连接（心跳与优雅关闭遍历用）。 */
export function allConns(): CollabConn[] {
  const out: CollabConn[] = [];
  for (const room of rooms.values()) for (const conn of room.conns) out.push(conn);
  return out;
}

/** 停掉全部定时器（防抖与 30s 兜底），关闭期间不再排新任务。 */
export function stopTimers(): void {
  if (tick) {
    clearInterval(tick);
    tick = null;
  }
  for (const room of rooms.values()) room.clearTimer();
}

/** 标记关闭中：此后 releaseConn 不再触发空置归结（关闭流程自己会 flush）。 */
export function beginShutdown(): void {
  shuttingDown = true;
}

/** 逐房间立即热持久化（+ 已注册的冷归结）。 */
export async function flushAllRooms(): Promise<void> {
  for (const room of [...rooms.values()]) {
    await room.flush("shutdown");
  }
}

/** 清空注册表并销毁全部 Y.Doc（必须在连接都已断开之后调用）。 */
export function disposeAll(): void {
  for (const room of rooms.values()) room.destroy();
  rooms.clear();
  creating.clear();
  shuttingDown = false;
}
