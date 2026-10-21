// apps/web/src/features/collab/collab-provider.ts
// 阶段 1 · 协同连接底座：拿票 → 连接 → 重连（**每次换新票**）→ 永久错误停连。
// 三类内容（doc / canvas / table）共用；本阶段**不接任何页面**，守住 D6「UI 冻结」。
// 依据 docs/design/2026-09-collab/DESIGN.md §2.2 / §4 / §5 / §9 阶段 1。
//
// 源码事实（据 y-websocket@3.1.0）: y-websocket@3.1.0 实际源码（src/y-websocket.js + dist/src/y-websocket.d.ts）：
//   1. `provider.url` 是 **getter**（serverUrl + '/' + roomname + '?' + params 现算）→ **不可写**；
//      换票只能改 `provider.params`（官方注明可安全修改，下一次建连时生效）。
//   2. 库内建重连复用同一份 params → **票据不会自动刷新**，而票据 60s 单次核销，第二次
//      握手必被拒。故传 `shouldReconnect: () => false` 关掉它的自动重连，重连由本文件的
//      退避循环独占 —— 这是「重连必换新票」的唯一落点。
//   3. 事件名与参数（.d.ts @extends）：status({status})、connection-close(CloseEvent|null,
//      provider)、connection-error(Event, provider)、closed({code,reason}, provider)、sync(bool)。
//   4. `disconnect()` 产生 **null 事件**的本地关闭，30s 无消息看门狗关闭也是 null 事件；
//      用 ownClose 标志区分二者，否则看门狗断连后永不重连。
// 服务端文本控制帧（revoked）不进二进制解析器，接收方式见 collab-socket.ts。

import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { getCollabTicket } from "../../api/client";
import { useAuthStore } from "../../store/auth";
import { COLLAB_CLOSE, isPermanentCollabClose } from "@gx/shared-types";
import type { CollabDenyReason, CollabServerControlMessage, CollabTicketResponse } from "@gx/shared-types";
import type { CollabAwarenessStates } from "./collab-presence";
import { createCollabSocketClass } from "./collab-socket";
import {
  appendLocalUpdate,
  clearLocalUpdates,
  hasLocalUpdates,
  loadMergedLocalState,
  LOCAL_REPLAY_ORIGIN,
} from "./yOfflinePersistence";
import { yOfflineEnabled } from "./yOfflineGate";

/** 状态机：idle 未开工（roomId 为空的初态，也是 disconnect 后的终态）／connecting 首次连接中／
 * connected 已接通／reconnecting 正在重试／offline 等退避窗口／denied **终态**（4400–4499 或 revoked）。 */
export type CollabStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline"
  | "denied";

export interface CollabConnectionOptions {
  /** 取票来源，默认走 api/client 的 REST 端点；单测注入假票据源。 */
  fetchTicket?: (roomId: string) => Promise<CollabTicketResponse>;
  /** 状态变化回调；denied 时第二个参数是拒绝原因（可能为 null）。 */
  onStatus?: (status: CollabStatus, reason: CollabDenyReason | null) => void;
  /** 退避抖动随机源，默认 Math.random；单测注入固定值以固定序列。 */
  random?: () => number;
  /** WS 地址的 origin 部分，默认当前页面 origin；单测显式注入。 */
  origin?: string;
  /**
   * 离线 gx-y 累积开关（YN9/S6-WEB-a，由 yOfflineGate 在壳/副本构建注入）。
   * 默认读构建门控（普通浏览器构建恒 false）；开则注册本地 update 累积、建 provider 前灌入。
   */
  offlinePersistence?: boolean;
  /**
   * 本地累积在一次服务端 sync 中被确认合并（gx-y 已清除）时回调；首次 sync 与每次断线重连后
   * 再次 sync 都会触发。页面据此把整篇 gx-kb-draft 降级清掉（字符级更新已上线，无需快照兜底）。
   */
  onLocalMerged?: () => void;
}

export interface CollabConnection {
  readonly roomId: string;
  /** 连接级身份 id（awareness 载荷里的 user.id）。叠加层据此把自己从「他人」里剔除 —— 必须按它而不是 userId
   *  判定，因为 DESIGN.md §5.1 明确「同账号多标签页显示为两个光标（符合预期）」。 */
  readonly selfId: string;
  readonly doc: Y.Doc;
  readonly status: CollabStatus;
  readonly denyReason: CollabDenyReason | null;
  /** 订阅在线名单变化。**必须**走这里而不是直接拿 awareness：provider 要等第一张票据返回
   * 后才创建（建它需要先知道服务端给的 wsPath），此前 awareness 尚不存在。返回取消订阅函数。 */
  onAwarenessChange(listener: (states: CollabAwarenessStates) => void): () => void;
  /**
   * 发布本地 awareness 字段（阶段 2 的 `selection` / `leases`）——这是「别人能看到我的光标」
   * 的唯一出口。
   *
   * provider 要等第一张票据返回后才创建（建它需要先知道服务端给的 wsPath，见文件头），
   * 而页面一进文档就要开始上报光标 —— 故**票据回来之前的发布请求一律缓存**，provider
   * 建好后补发；静默丢弃会让「刚进文档那几秒」的光标与占用永远发不出去（最难复现的那类 bug）。
   * 值传 `null` 表示清除该字段（y-protocols@1.0.7 的 setLocalStateField 是「赋 null」；
   * 接收侧 collab-presence 对 null 与缺键一视同仁，都是 selection: null / leases: []）。
   */
  setLocalFields(fields: Record<string, unknown>): void;
  /** 幂等：可重复调用。清定时器 → provider.destroy() → doc.destroy()。 */
  disconnect(): void;
}

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/** 非浏览器环境（单测）下的兜底 origin。 */
function defaultOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : "http://localhost";
}

/** 拼 WS 地址：`http(s)` → `ws(s)`，再拼 `${wsPath}?t=<ticket>`。 */
export function buildWsUrl(wsPath: string, ticket: string, origin?: string): string {
  const path = wsPath.startsWith("/") ? wsPath : `/${wsPath}`;
  return `${toWsOrigin(origin ?? defaultOrigin())}${path}?t=${encodeURIComponent(ticket)}`;
}

function toWsOrigin(origin: string): string {
  // https://host → wss://host；http://host → ws://host（尾巴上的 's' 天然留下）
  if (origin.startsWith("https://")) return `wss://${origin.slice("https://".length)}`;
  if (origin.startsWith("http://")) return `ws://${origin.slice("http://".length)}`;
  return origin; // 已是 ws/wss 或非标准形态：原样透传
}

/**
 * 首次同步完成信号。
 *
 * 为什么必须单独暴露：`provider.status === "connected"` 只表示 WebSocket 打开，此时
 * 房间的内容（sync step2）**还没到**。谁要是拿它当「房间里有没有内容」的判据，就会在
 * 一个明明已有内容的房间里再播一遍种子 —— 真机表现为「第二个人打开文档，正文翻成两份」。
 * 故这里把 y-websocket 的 `sync` 事件单独收口，供播种逻辑作前置条件。
 */
const syncedDocs = new WeakSet<Y.Doc>();
const syncedWaiters = new WeakMap<Y.Doc, Set<() => void>>();

/** 该 doc 是否已收到过服务端的全量内容（首次 sync 完成）。 */
export function isDocSynced(doc: Y.Doc): boolean {
  return syncedDocs.has(doc);
}

/** 订阅首次 sync 完成；已同步则立即回调一次。返回取消订阅。 */
export function onDocSynced(doc: Y.Doc, cb: () => void): () => void {
  if (syncedDocs.has(doc)) {
    cb();
    return () => {};
  }
  let set = syncedWaiters.get(doc);
  if (!set) {
    set = new Set();
    syncedWaiters.set(doc, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

function markDocSynced(doc: Y.Doc): void {
  if (syncedDocs.has(doc)) return;
  syncedDocs.add(doc);
  const waiters = syncedWaiters.get(doc);
  syncedWaiters.delete(doc);
  if (!waiters) return;
  for (const cb of waiters) cb();
}

/** 第 attempt 次重试的等待毫秒：1s→2s→4s→8s…→30s 封顶，带 ±20% 抖动（attempt 从 1 起）。 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS);
  const jitter = 1 + (clamp01(random()) * 2 - 1) * 0.2;
  return Math.round(raw * jitter);
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** 4400–4499 → 拒绝原因。不在契约枚举里的码统一归 no_access。 */
const CLOSE_DENY_REASON: Record<number, CollabDenyReason> = {
  [COLLAB_CLOSE.UNAUTHORIZED]: "ticket_invalid",
  [COLLAB_CLOSE.READONLY_WRITE]: "readonly",
  [COLLAB_CLOSE.HANDSHAKE_TIMEOUT]: "handshake_timeout",
};
export function denyReasonOfClose(code: number): CollabDenyReason {
  return CLOSE_DENY_REASON[code] ?? "no_access";
}

export function createCollabConnection(
  roomId: string,
  opts: CollabConnectionOptions = {},
): CollabConnection {
  const fetchTicket = opts.fetchTicket ?? getCollabTicket;
  const random = opts.random ?? Math.random;
  const origin = opts.origin ?? defaultOrigin();

  const doc = new Y.Doc();
  /** 连接级唯一 id：同一账号多个标签页 = 多条 presence（DESIGN.md §5.1）。 */
  const selfId = crypto.randomUUID();
  const awarenessListeners = new Set<(states: CollabAwarenessStates) => void>();

  // —— 离线 gx-y 累积（YN9/S6-WEB-a）。doc/canvas 共用，挂在连接底座上，与房间内容无关 ——
  const persistOffline = opts.offlinePersistence ?? yOfflineEnabled();
  /**
   * 「已与服务端确认合并」窗口：false 时（首次连接前 / 断线重连中）本地事务追加到 gx-y；
   * 一旦 sync 完成置 true，稳态协同不再落盘（否则 gx-y 随每次击键无限增长），断线再置回 false。
   */
  let mergeConfirmed = false;

  if (persistOffline) {
    // 建任何 WebSocketProvider 之前先把本地累积灌进 doc，避免与服务端 sync step1 竞态：
    // y-websocket 在建连 onopen 时才发 sync step1（携带本 doc 的 state vector），此刻灌入的
    // 内容已在 doc 里，会被随后 step1 对服务端缺失的部分作为 update 带走，服务端自然合并。
    // 灌入在 createCollabConnection 内同步执行、且先于 open()，整段连接生命周期只会发生一次，
    // 重连换票复用同一 Y.Doc 实例，无需标志位防重。
    const localState = loadMergedLocalState(roomId);
    if (localState) {
      Y.applyUpdate(doc, localState, LOCAL_REPLAY_ORIGIN);
    }
    // 只回存「本地编辑事务」。判据是 yjs 的 transaction.local：
    //   · 编辑器绑定写入 / seedBlocks 播种走 doc.transact(...) → local=true；
    //   · 从本地存储灌入（Y.applyUpdate，内部强制 transaction.local=false，见 yjs readUpdateV2）
    //     与服务端 sync step2、跨标签页 BroadcastChannel 转发（都是 applyUpdate）→ local=false。
    // 因此灌入与远端内容都不会被二次回存，无需识别具体 origin 对象，天然与 roomId/内容解耦。
    const onLocalUpdate = (update: Uint8Array, _origin: unknown, _d: Y.Doc, transaction: Y.Transaction): void => {
      if (!transaction.local || mergeConfirmed) return;
      appendLocalUpdate(roomId, update, { clientId: doc.clientID, ts: Date.now() });
    };
    doc.on("update", onLocalUpdate);
  }

  let provider: WebsocketProvider | null = null;
  let status: CollabStatus = "idle";
  let denyReason: CollabDenyReason | null = null;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  /** 我们自己调用 disconnect/destroy 引发的本地关闭（区别于看门狗的 null 事件）。 */
  let ownClose = false;
  /** provider 建好之前收到的发布请求（键 → 值，值为 null 表示待清除）。见接口注释。 */
  let pendingFields: Map<string, unknown> | null = null;

  /** awareness 写入口：provider 在就直接写，不在就缓存待补发。 */
  function setLocalFields(fields: Record<string, unknown>): void {
    if (destroyed) return;
    for (const [key, value] of Object.entries(fields)) {
      if (provider) {
        provider.awareness.setLocalStateField(key, value);
      } else {
        if (!pendingFields) pendingFields = new Map();
        pendingFields.set(key, value);
      }
    }
  }

  /** provider 刚建好：把缓存的发布请求补发一次（只补一次，随后清空）。 */
  function flushPendingFields(): void {
    const pending = pendingFields;
    pendingFields = null;
    if (!pending || !provider) return;
    for (const [key, value] of pending) provider.awareness.setLocalStateField(key, value);
  }

  function setStatus(next: CollabStatus, reason: CollabDenyReason | null = null): void {
    if (status === next && denyReason === reason) return;
    status = next;
    denyReason = reason;
    opts.onStatus?.(next, reason);
  }

  function clearRetry(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  /** 安排下一次重试。此刻尚未发起连接，故状态为 offline。 */
  function scheduleRetry(): void {
    if (destroyed) return;
    clearRetry();
    attempt += 1;
    setStatus("offline");
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void open(true);
    }, backoffDelayMs(attempt, random));
  }

  function closeTransport(): void {
    ownClose = true;
    try {
      provider?.disconnect();
    } finally {
      ownClose = false;
    }
  }

  function handleControlText(raw: string): void {
    let msg: CollabServerControlMessage;
    try {
      msg = JSON.parse(raw) as CollabServerControlMessage;
    } catch {
      return; // 非法 JSON：忽略，不影响同步通道
    }
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type !== "revoked") return; // peer_left / flushed 留给阶段 2 消费
    if (destroyed) return;
    clearRetry();
    closeTransport();
    setStatus("denied", msg.reason ?? "downgraded");
  }

  function applyIdentity(ticket: CollabTicketResponse): void {
    if (!provider) return;
    // userId 一律以服务端票据为准（guest 恒 null）；本地会话仅在票据尚未携带该字段时临时顶替。
    const fallbackId = ticket.kind === "guest" ? null : (useAuthStore.getState().user?.id ?? null);
    const userId = typeof ticket.userId === "string" && ticket.userId ? ticket.userId : fallbackId;
    provider.awareness.setLocalStateField("user", {
      id: selfId,
      kind: ticket.kind,
      userId,
      nick: ticket.nick,
      color: ticket.color,
    });
  }

  /** 从服务端给的 wsPath 反解 y-websocket 需要的 (serverUrl, roomname)：它按
   * `serverUrl + '/' + roomname + '?' + params` 拼地址，而 wsPath 末段就是房间标识
   * （契约示例 `/ws/collab/doc%3Aabc`）。用 buildWsUrl 产出完整 URL 后去掉查询串，
   * 再按最后一个 '/' 切分，确保我们与库算出同一个地址。 */
  function splitEndpoint(ticket: CollabTicketResponse): { serverUrl: string; roomname: string } {
    const full = buildWsUrl(ticket.wsPath, ticket.ticket, origin);
    const qIndex = full.indexOf("?");
    const beforeQuery = qIndex >= 0 ? full.slice(0, qIndex) : full;
    const slash = beforeQuery.lastIndexOf("/");
    return { serverUrl: beforeQuery.slice(0, slash), roomname: beforeQuery.slice(slash + 1) };
  }

  function emitAwareness(): void {
    if (!provider) return;
    const states = provider.awareness.getStates() as CollabAwarenessStates;
    for (const listener of awarenessListeners) listener(states);
  }

  function attachProvider(next: WebsocketProvider): void {
    provider = next;
    next.on("status", (event: { status: "connected" | "disconnected" | "connecting" }) => {
      if (destroyed) return;
      if (event.status === "connected") {
        attempt = 0; // 建连成功 → 重置退避
        setStatus("connected", null);
      } else if (event.status === "connecting") {
        setStatus(attempt === 0 ? "connecting" : "reconnecting");
      }
      // 'disconnected' 不在这里处理：关闭语义统一由 connection-close 判定，避免双路径重入。
    });
    next.on("sync", (isSynced: boolean) => {
      if (!isSynced) return;
      markDocSynced(doc);
      if (!persistOffline) return;
      // 首次（及断线重连后再次）完成 sync：此刻本地更新已随客户端 sync step2 被服务端
      // 拉取合并（客户端 onopen 发 step1 → 服务端 step1 → 客户端 step2 携带全量本地 diff，
      // 均在本 step2 到达之前完成）。先记下是否确有待确认的本地累积，再清键并关闭累积窗口；
      // 仅在确实合并了本地内容时通知上层清整篇 draft（稳态 synced 不应误清无关草稿）。
      const hadPending = hasLocalUpdates(roomId);
      clearLocalUpdates(roomId);
      mergeConfirmed = true;
      if (hadPending) opts.onLocalMerged?.();
    });
    next.on("connection-close", (event: CloseEvent | null) => {
      if (destroyed) return;
      // 断了线：确认窗口关闭，离线期间的本地事务重新累积进 gx-y（重连再灌/再带走上行）。
      mergeConfirmed = false;
      if (event === null) {
        if (!ownClose) scheduleRetry(); // 看门狗断连也要重连
        return;
      }
      if (isPermanentCollabClose(event.code)) {
        clearRetry();
        setStatus("denied", denyReasonOfClose(event.code));
        return;
      }
      scheduleRetry();
    });
    next.awareness.on("change", emitAwareness);
    // 身份之后立刻补发缓存的 selection/leases：远端可能在建连前就已经点进了某个块。
    flushPendingFields();
  }

  async function open(reconnect: boolean): Promise<void> {
    if (destroyed) return;
    setStatus(reconnect ? "reconnecting" : "connecting");
    let ticket: CollabTicketResponse;
    try {
      ticket = await fetchTicket(roomId);
    } catch {
      // 取票失败按一次失败的重试处理（网络抖动 / 服务端临时不可用），不做永久判定。
      if (!destroyed) scheduleRetry();
      return;
    }
    if (destroyed) return;
    if (!provider) {
      const { serverUrl, roomname } = splitEndpoint(ticket);
      attachProvider(
        new WebsocketProvider(serverUrl, roomname, doc, {
          params: { t: ticket.ticket },
          // 见文件头第 2 条：每次重连都必须换新票，库自带重连做不到。
          shouldReconnect: () => false,
          WebSocketPolyfill: createCollabSocketClass(handleControlText),
          // 不传 disableBc：保留 BroadcastChannel 跨标签页转发（DESIGN.md §5.1）。
        }),
      );
    } else {
      // 换新票：`url` 是 getter 不可写，只能改 params（下一次建连生效）。
      provider.params.t = ticket.ticket;
      provider.connect();
    }
    applyIdentity(ticket);
  }

  void open(false);

  return {
    roomId,
    selfId,
    doc,
    get status(): CollabStatus {
      return status;
    },
    get denyReason(): CollabDenyReason | null {
      return denyReason;
    },
    onAwarenessChange(listener: (states: CollabAwarenessStates) => void): () => void {
      awarenessListeners.add(listener);
      if (provider) emitAwareness();
      return () => awarenessListeners.delete(listener);
    },
    setLocalFields,
    disconnect(): void {
      if (destroyed) return; // 幂等
      destroyed = true;
      clearRetry();
      awarenessListeners.clear();
      pendingFields = null; // 连接已死，缓存的发布请求随之作废
      const alive = provider;
      provider = null;
      if (alive) {
        ownClose = true;
        try {
          alive.destroy();
        } finally {
          ownClose = false;
        }
      }
      doc.destroy();
      setStatus("idle", null);
    },
  };
}
