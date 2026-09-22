// apps/api/src/collab/attach.ts
// WebSocket 通道：接管 http.Server 的 upgrade，把 /ws/collab/<roomId> 接进房间。
//
// 为什么自己接管 upgrade：@hono/node-ws 已 DEPRECATED，本机 @hono/node-server 的
// getRequestListener 不处理 upgrade（DESIGN §2.1），所以这条事件目前无人监听。
//
// ★ 拒绝纪律（§4.2）：**拒绝 upgrade 在浏览器侧只表现为 opaque 1006 + 无限重连**。
//   因此凡是「客户端本来想连上」的失败（票据无效/已核销/无权访问），一律
//   **先 wss.handleUpgrade 完成握手，再 ws.close(4401, ...)** —— 4400–4499 是私有段，
//   客户端判定为永久错误而停止重连。只有「路径根本不是协同端点」才直接 destroy 裸 socket
//   （那种请求不来自协同客户端，没有重连语义）。
//
// 服务端只认 y-protocols 四种码（0=sync / 1=awareness / 2=auth / 3=queryAwareness），
// 全程不 import 任何编辑器实现，也不解析 Y.Doc 内容——内容对它只是黑盒二进制。

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { COLLAB_CLOSE } from "@gx/shared-types";
import { config } from "../config.js";
import { MSG, SYNC_SUB, readAwarenessPayload, readFrameHead } from "./protocol.js";
import { createEncoder, toUint8Array, writeVarUint } from "./codec.js";
import * as syncProtocol from "y-protocols/sync.js";
import type { CollabConn, CollabRoom } from "./room.js";
import { acquireRoom, allConns, releaseConn } from "./registry.js";
import { redeemTicket } from "./tickets.js";

const ROUTE_PREFIX = "/ws/collab/";
/** 心跳间隔（§5.2：30s 无 pong 即剔除，与 y-websocket-server 的 pingTimeout 对齐）。 */
const PING_INTERVAL_MS = 30_000;
/** 优雅关闭：1001 going away。 */
const CLOSE_GOING_AWAY = 1001;

const servers = new Set<WebSocketServer>();
let pingTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 把一个 http.Server 挂上协同 WS。**两处 createServer（TCP / unix socket）都必须调用**，
 * 漏一处 = 某种部署形态下协同不工作（§8-1）。
 */
export function attachCollab(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  servers.add(wss);
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(wss, req, socket, head);
  });
  ensurePing();
}

async function handleUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  // pathname 需先剥掉网关前缀（GX_BASE_PATH 可能非空，如 /app/gouxiangdb）。
  let pathname = url.pathname;
  if (config.basePath && pathname.startsWith(config.basePath)) {
    pathname = pathname.slice(config.basePath.length);
  }
  if (!pathname.startsWith(ROUTE_PREFIX) || pathname.length === ROUTE_PREFIX.length) {
    // 不是协同端点：本进程没有其它 upgrade 消费者，直接销毁裸 socket（该请求不来自
    // 协同客户端，不存在"无限重连"问题）。
    socket.destroy();
    return;
  }
  const roomId = decodeRoomSegment(pathname.slice(ROUTE_PREFIX.length));
  const ticket = url.searchParams.get("t") ?? "";
  // 先握手、后判定：任何凭据/房间问题都在 ws 上以 4401 表达（见文件头纪律）。
  wss.handleUpgrade(req, socket, head, (ws) => {
    void serveConnection(ws, roomId, ticket);
  });
}

/** roomId 是 encodeURIComponent 过的（"doc:abc" → "doc%3Aabc"）；解码失败返回 null。 */
function decodeRoomSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

async function serveConnection(ws: WebSocket, roomId: string | null, ticket: string): Promise<void> {
  const payload = roomId ? redeemTicket(ticket) : null;
  if (!roomId || !payload || payload.roomId !== roomId) {
    // 无票据 / 伪造票据 / 票据已核销 / 跨房复用 —— 一律 4401。
    closeWith(ws, COLLAB_CLOSE.UNAUTHORIZED, "ticket_invalid");
    return;
  }

  // ★ 先挂 message 监听，再 await 建房间。
  // acquireRoom 里有 DB 查询（验对象存在 + 读 collab_docs），这段 await 期间客户端的
  // sync step1 已经发到了；EventEmitter 在没有监听者时会**直接丢弃**这些帧，
  // 表现为"重连后拿不到历史内容"（首次连接由服务端先发 step1，恰好掩盖了这个问题）。
  const pending: Uint8Array[] = [];
  let room: CollabRoom | null = null;
  let conn: CollabConn | null = null;
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    // 文本帧：服务端→客户端的控制消息才是文本，客户端发来的文本帧一律忽略（不断连）。
    if (!isBinary) return;
    const frame = new Uint8Array(data); // 拷贝一份：ws 的 Buffer 来自共享池
    if (!room || !conn) {
      pending.push(frame);
      return;
    }
    handleFrame(room, conn, frame);
  });

  const acquired = await acquireRoom(roomId);
  if (!acquired) {
    // 房间不存在（对象被删 / kind 不自洽 / 阶段未开放的表房间）。
    closeWith(ws, COLLAB_CLOSE.UNAUTHORIZED, "no_access");
    return;
  }
  room = acquired;

  conn = {
    id: randomUUID().slice(0, 8),
    ws,
    subject: payload.subject,
    userId: payload.userId,
    role: payload.role,
    nick: payload.nick,
    color: payload.color,
    alive: true,
  };
  room.addConn(conn);

  // 服务端主动发一次 sync step1：客户端不必先开口，连上即可收到全量。
  const hello = createEncoder();
  writeVarUint(hello, MSG.SYNC);
  syncProtocol.writeSyncStep1(hello, room.doc);
  sendFrame(conn, toUint8Array(hello));

  // ★ 连上即下发全量 awareness 快照（与 step1 并列）。
  // y-websocket 只会**广播自己的** awareness，不会主动发 queryAwareness；而房间对
  // awareness 变更的广播一律「排除发送者」。两者叠加的结果：后加入的人永远收不到
  // 已在线者的名单 —— 表现为「先来的人看得见后来的人，后来的人名单里一个人都没有」，
  // 并连带触发播种竞态（看不到 peer 就以为房间里没人，见 useCollabDoc）。
  sendFrame(conn, room.encodeAwarenessSnapshot());

  // 排空建房间期间到达的帧（顺序保持：客户端的 step1 可能比服务端的 hello 更早发出）。
  for (const frame of pending) handleFrame(room, conn, frame);
  pending.length = 0;

  ws.on("pong", () => {
    conn.alive = true;
  });
  ws.on("close", () => {
    releaseConn(room, conn);
  });
  // 单条 socket 的 error（对端强拆等）不能冒成未处理事件把进程带崩；连接清理走 close。
  ws.on("error", () => {
    /* 已由 close 收口 */
  });
}

function handleFrame(room: CollabRoom, conn: CollabConn, frame: Uint8Array): void {
  const head = readFrameHead(frame);
  if (!head) return; // 空帧/截断帧：忽略，不断连（未知 op 不该踢人）。

  switch (head.messageType) {
    case MSG.SYNC: {
      // 只读连接：sync update 子消息 = 尝试写 → 4403。
      // 判定走帧头 varUint（不是正则兜底——正则会误吞未知 op，§11 已记过一次）。
      // step1/step2 必须放行，否则读也被误伤。
      if (conn.role !== "editor" && head.syncSubType === SYNC_SUB.UPDATE) {
        conn.ws.close(COLLAB_CLOSE.READONLY_WRITE, "readonly");
        return;
      }
      const response = room.handleSync(frame, conn);
      if (response) sendFrame(conn, response);
      return;
    }
    case MSG.AWARENESS: {
      const payload = readAwarenessPayload(frame);
      if (!payload) return;
      room.applyAwareness(payload, conn);
      return;
    }
    case MSG.QUERY_AWARENESS: {
      sendFrame(conn, room.encodeAwarenessSnapshot());
      return;
    }
    default:
      // 2=auth：本阶段不用（鉴权在握手票据里做完了）。未知码一律忽略，不断连。
      return;
  }
}

function sendFrame(conn: CollabConn, frame: Uint8Array): void {
  try {
    conn.ws.send(frame);
  } catch {
    // 单条发送失败交给心跳/close 收口，不影响本轮其它连接。
  }
}

function closeWith(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    ws.terminate();
  }
}

/** 心跳：单个全局定时器遍历全部连接（不是每连接一个），死连接 terminate 掉。 */
function ensurePing(): void {
  if (pingTimer) return;
  pingTimer = setInterval(() => {
    for (const conn of allConns()) {
      if (!conn.alive) {
        // 没收到上一轮 pong：直接掐断，让房间能走到「空置 → 冷归结」。
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref();
}

/**
 * 优雅关闭：主动关掉所有协同长连接并停掉心跳。
 * **必须先于 server.close()** —— 否则在线 WS 会让 close 的回调一直等下去。
 */
export function closeAllCollabSockets(): void {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  for (const conn of allConns()) {
    try {
      conn.ws.close(CLOSE_GOING_AWAY, "server_shutdown");
    } catch {
      /* best-effort：关闭路径不再重试 */
    }
  }
  for (const wss of servers) {
    try {
      wss.close();
    } catch {
      /* best-effort */
    }
  }
  servers.clear();
}
