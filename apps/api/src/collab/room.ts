// apps/api/src/collab/room.ts
// 协同房间：一个 roomId 一个 Y.Doc + 一份 awareness + 一组连接 + 两档写。
//
// ★ 两档写（DESIGN §2.3）：
//   热路径：doc 的 update 事件 → 置 dirty → 500ms 防抖 → 只写 collab_docs 一行
//           （不碰 kb_docs/records、不 bump updatedAt、不跑 nav、不发 outbox）。
//   冷归结：房间空置（最后一人离开）立即一次 + 长会话每 30s 兜底（走 dirty 门、单全局
//           定时器，见 registry.ts）。阶段 1 只搭机制：registerRoomFlusher 注入点已就绪，
//           但没有任何 kind 注册 flusher —— 未注册时归结只做热持久化并显式告警，
//           **不得静默**（§3.7.4：丢的是用户已确认、不可重放的输入）。
//
// 房间级串行标志（flushing）：保证同一个房间里 hot 写与 cold 归结不交错（R13）。

import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness.js";
import * as syncProtocol from "y-protocols/sync.js";
import type { CollabKind, CollabPresenceEntry } from "@gx/shared-types";
import { concatBytes, createDecoder, createEncoder, readVarUint, toUint8Array, varUintBytes, writeVarUint } from "./codec.js";
import { MSG, SYNC_SUB } from "./protocol.js";
import { saveCollabState } from "./store.js";
import { buildPresenceEntry, type CollabIdentity } from "./presence.js";

/** 热路径防抖窗口：与 §2.3 一致（500ms）。 */
export const HOT_DEBOUNCE_MS = 500;

const WS_OPEN = 1;

/** attach 层对一条 WebSocket 的最小依赖（不把具体库类型带进房间层）。 */
export interface CollabSocket {
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** 心跳：由 attach 层的单个全局定时器驱动（不是每连接一个定时器）。 */
  ping(): void;
  /** 死连接直接掐断：留给「永不空置」的房间兜底，否则冷归结永不触发。 */
  terminate(): void;
}

export interface CollabConn extends CollabIdentity {
  /** 连接级唯一 id（服务端派发，排障用）。 */
  id: string;
  ws: CollabSocket;
  /** 心跳存活标记：收到 pong 置 true，每轮 ping 前置 false。 */
  alive: boolean;
}

export type CollabFlushReason = "debounce" | "empty" | "tick" | "shutdown";

/** 冷归结（阶段 2/3/4 才注册）：把房间的 Y.Doc 内容并回主库既有写事务。 */
export type RoomFlusher = (room: CollabRoom) => Promise<void>;

const flushers = new Map<CollabKind, RoomFlusher>();

/** 注入某类内容的冷归结实现（阶段 1 无调用方，供后续阶段接主库）。 */
export function registerRoomFlusher(kind: CollabKind, fn: RoomFlusher): void {
  flushers.set(kind, fn);
}

export function getRoomFlusher(kind: CollabKind): RoomFlusher | undefined {
  return flushers.get(kind);
}

function asConn(origin: unknown): CollabConn | null {
  if (typeof origin === "object" && origin !== null && "ws" in origin && "userId" in origin) {
    return origin as CollabConn;
  }
  return null;
}

function sendFrame(conn: CollabConn, frame: Uint8Array): void {
  if (conn.ws.readyState !== WS_OPEN) return;
  // 单条发送失败不能打断本轮广播（该连接多半已在关闭过程中，attach 层有心跳兜底清理）。
  try {
    conn.ws.send(frame);
  } catch (e) {
    console.warn(`[collab] send failed conn=${conn.id} room=`, e);
  }
}

export class CollabRoom {
  readonly roomId: string;
  readonly kind: CollabKind;
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  readonly conns = new Set<CollabConn>();
  /** awareness clientId → 所属连接（presence 的 role/nick/color 取服务端权威值）。 */
  readonly clientConn = new Map<number, CollabConn>();

  /** 热持久化门：有未写 collab_docs 的变更。hot 写成功后清。 */
  dirty = false;
  /**
   * 冷归结门：自上次**成功冷归结**以来是否有过变更。只有 flush() 跑完 flusher 才清，
   * 热持久化**不清**它。
   *
   * 为什么必须和 dirty 分开：dirty 在 500ms 热持久化之后就被清成 false，而 registry 的
   * 30s 兜底节拍原本走的就是 dirty 门 —— 于是「长会话每 30s 兜底」永远不触发，冷归结
   * 只在房间空置/关进程时发生一次。真机实测：两人开着页面打了 42 秒字，kb_docs 一动不动
   * （内容只躺在 collab_docs 里），而界面一直显示「已保存到云端」。此时进程被强杀，
   * 从上次空置以来的编辑全部丢失。
   */
  coldDirty = false;
  /** 最后编辑者的真实 userId（冷归结的 updatedBy 要用；无编辑者则跳过归结，①）。 */
  lastEditorUserId: string | null = null;
  /** 房间建立时的 kb_docs.contentVersion（判「空置期间是否被 HTTP PUT 改过」的唯一依据）。 */
  baseVersion: number | null;
  /**
   * 与 baseVersion 同一时刻读到的主库正文（doc = Markdown，canvas = 元素 JSON）。
   * 三方归并的 base：在线编辑 = baseContent + 本地改动，外部整篇覆盖写要按它判定"谁动过"。
   * 每次归结成功后由 flusher 推进到刚写进去的内容（见 docFlush.ts）。
   */
  baseContent: string | null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 房间级串行标志：hot 写与 cold 归结不交错。 */
  private flushing = false;
  private destroyed = false;

  constructor(opts: {
    roomId: string;
    kind: CollabKind;
    initialState: Uint8Array | null;
    baseVersion: number | null;
    /** 与 baseVersion 同刻读到的主库正文（冷归结三方归并的 base；见字段注释）。 */
    baseContent?: string | null;
  }) {
    this.roomId = opts.roomId;
    this.kind = opts.kind;
    this.baseVersion = opts.baseVersion;
    this.baseContent = opts.baseContent ?? null;
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    // 服务端不是参与者：本地状态置空，否则 presence 里会常驻一个幽灵条目。
    this.awareness.setLocalState(null);
    // 先恢复历史协同态，再挂事件——避免把「加载」误判成一次编辑（dirty/lastEditor）。
    if (opts.initialState && opts.initialState.length > 0) {
      Y.applyUpdate(this.doc, opts.initialState, "collab.load");
    }
    this.doc.on("update", this.handleDocUpdate);
    this.awareness.on("update", this.handleAwarenessUpdate);
  }

  // ============ 热路径 ============

  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    const conn = asConn(origin);
    if (conn) this.lastEditorUserId = conn.userId;
    this.dirty = true;
    this.coldDirty = true;
    this.broadcastDocUpdate(update, conn);
    this.schedulePersist();
  };

  private broadcastDocUpdate(update: Uint8Array, origin: CollabConn | null): void {
    const encoder = createEncoder();
    // y-protocols 的 writeUpdate 只写【sync 子类型】，外层 messageSync 必须自己先写
    // （y-websocket 的 send 也是这个顺序）——漏了这行，客户端会把帧读成 messageType=2(auth)
    // 而整条丢弃，表现为"服务端收到了、对端却没变化"。
    writeVarUint(encoder, MSG.SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const frame = toUint8Array(encoder);
    for (const conn of this.conns) {
      if (conn === origin) continue;
      sendFrame(conn, frame);
    }
  }

  private schedulePersist(): void {
    if (this.timer || this.destroyed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistHot();
    }, HOT_DEBOUNCE_MS);
    // 不阻止进程退出：优雅关闭走 flushAllAndClose 主动落盘。
    this.timer.unref();
  }

  /** 热持久化：只写 collab_docs 一行，走 runWrite("collab.hot")。 */
  private async persistHot(): Promise<void> {
    await this.withRoomLock(async () => {
      if (!this.dirty) return;
      await this.writeState();
    });
  }

  private async writeState(): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.doc);
    await saveCollabState(this.roomId, this.kind, state, this.baseVersion);
    this.dirty = false;
  }

  // ============ 冷归结 ============

  /**
   * 归结一次：先热持久化（dirty 门），再交给该 kind 注册的 flusher。
   * 未注册 flusher 时只落 collab_docs 并显式告警——阶段 1 的常态，不是异常。
   */
  async flush(reason: CollabFlushReason): Promise<void> {
    if (this.destroyed) return;
    await this.withRoomLock(async () => {
      this.clearTimer();
      if (this.dirty) await this.writeState();
      const flusher = getRoomFlusher(this.kind);
      if (!flusher) {
        console.warn(`[collab] no flusher for kind=${this.kind} room=${this.roomId} reason=${reason}`);
        return;
      }
      await flusher(this);
      // 只有真正走完归结才清冷门；flusher 抛错时保留，下一轮 tick / 空置会重试。
      this.coldDirty = false;
    });
  }

  /** 房间级串行：同一时刻只允许一个写者（hot 或 cold）。 */
  private async withRoomLock(task: () => Promise<void>): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      await task();
    } catch (e) {
      // 失败保留 dirty（writeState 只在成功后清），下一轮防抖/归结会重试；
      // 这里只负责出声——协同落盘失败必须可见（§3.7.4）。
      console.error(`[collab] flush failed room=${this.roomId} kind=${this.kind}`, e);
    } finally {
      this.flushing = false;
    }
  }

  // ============ 消息（只认 y-protocols 四种码，全程不碰内容语义） ============

  /** 处理一条 sync 帧；返回要回给该连接的响应帧（仅 step1 有响应，其余 null）。 */
  handleSync(frame: Uint8Array, conn: CollabConn): Uint8Array | null {
    const decoder = createDecoder(frame);
    readVarUint(decoder); // 消费 messageType（调用方已判定为 SYNC）
    const encoder = createEncoder();
    writeVarUint(encoder, MSG.SYNC);
    const sub = syncProtocol.readSyncMessage(decoder, encoder, this.doc, conn);
    if (sub !== SYNC_SUB.STEP1) return null;
    return toUint8Array(encoder);
  }

  /** 应用一条 awareness 载荷（不可信输入，presence 层做白名单裁剪）。 */
  applyAwareness(payload: Uint8Array, conn: CollabConn): void {
    applyAwarenessUpdate(this.awareness, payload, conn);
  }

  /** 回应 queryAwareness 与建连快照：把当前全部在线状态整包回发。 */
  encodeAwarenessSnapshot(): Uint8Array {
    // 只发**有状态**的客户端：服务端自己的 localState 是 null（它不是参与者），
    // 未清理的 null 槽位同理，发出去只会在对端留下一个空壳条目。
    const clients: number[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (state !== null && state !== undefined) clients.push(clientId);
    }
    const payload = encodeAwarenessUpdate(this.awareness, clients);
    return concatBytes([varUintBytes(MSG.AWARENESS), varUintBytes(payload.length), payload]);
  }

  private handleAwarenessUpdate = (
    ev: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const conn = asConn(origin);
    const changed = [...ev.added, ...ev.updated, ...ev.removed];
    if (conn) {
      for (const id of ev.added) this.clientConn.set(id, conn);
      for (const id of ev.updated) this.clientConn.set(id, conn);
      for (const id of ev.removed) this.clientConn.delete(id);
    }
    if (changed.length === 0) return;
    const payload = encodeAwarenessUpdate(this.awareness, changed);
    const frame = concatBytes([varUintBytes(MSG.AWARENESS), varUintBytes(payload.length), payload]);
    // 服务端不解析内容，但 presence 是结构化数据：广播前不过滤字段，裁剪只发生在
    // 组装 presence（HTTP 快照）时——线上一律原样转发，避免服务端改动客户端语义。
    for (const c of this.conns) {
      if (c === conn) continue;
      sendFrame(c, frame);
    }
  };

  // ============ 连接生命周期 ============

  addConn(conn: CollabConn): void {
    this.conns.add(conn);
  }

  /** 移除连接：先剔除其 awareness，再返回结果供注册表判断是否空置。 */
  removeConn(conn: CollabConn): boolean {
    this.conns.delete(conn);
    const clientIds: number[] = [];
    for (const [clientId, owner] of this.clientConn) {
      if (owner === conn) clientIds.push(clientId);
    }
    for (const id of clientIds) this.clientConn.delete(id);
    if (clientIds.length > 0) removeAwarenessStates(this.awareness, clientIds, null);
    return this.conns.size === 0;
  }

  /** 在线名单快照（presence 端点与排障共用；载荷已白名单裁剪）。 */
  presence(): CollabPresenceEntry[] {
    const out: CollabPresenceEntry[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (state === null || state === undefined) continue;
      out.push(buildPresenceEntry(clientId, state, this.clientConn.get(clientId) ?? null));
    }
    return out;
  }

  clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearTimer();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
