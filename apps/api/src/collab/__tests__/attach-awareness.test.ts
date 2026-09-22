// apps/api/src/collab/__tests__/attach-awareness.test.ts
// 「后加入者必须看得见已在线的人」的连线级回归（真 http.Server + 真 WebSocket + 临时库）。
//
// 起因（真机实测）：两个浏览器打开同一文档，先开的页面上能看到后来者的头像，后来者的
// 头像区**整块不存在**；同一时刻服务端 presence 端点明明返回 2 条。根因是服务端建连时
// 只主动发了 sync step1，没发 awareness 快照，而 y-websocket 既不会主动 queryAwareness、
// 房间对 awareness 变更的广播又一律排除发送者 —— 后来者永远收不到先来者的名单。
//
// 本文件直接连真 WS 收帧断言，不经过 React，因此不受前端改动影响，也不需要重启服务。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness.js";
import { WebSocket } from "ws";
import { awarenessClientIds, MSG, readAwarenessPayload } from "../protocol.js";
import { concatBytes, varUintBytes } from "../codec.js";

type AttachMod = typeof import("../attach.js");
type TicketMod = typeof import("../tickets.js");
type RegistryMod = typeof import("../registry.js");

const U = "u1";
const ROOM = "doc:d1";

let tmpDir: string;
let prisma: PrismaClient;
let attach: AttachMod;
let tickets: TicketMod;
let registry: RegistryMod;
let server: Server;
let baseWs: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-collab-attach-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "r.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  (globalThis as { __gx_prisma?: PrismaClient }).__gx_prisma = prisma;
  [attach, tickets, registry] = await Promise.all([
    import("../attach.js"),
    import("../tickets.js"),
    import("../registry.js"),
  ]);

  await prisma.user.create({ data: { id: U, email: "u1@x.com", displayName: "u1", passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" } });
  await prisma.knowledgeBase.create({ data: { id: "kb1", name: "知识库一", createdBy: U } });
  await prisma.kbDoc.create({ data: { id: "d1", kbId: "kb1", kind: "doc", title: "文档", content: "x", createdBy: U, updatedBy: U } });

  server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  attach.attachCollab(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseWs = `ws://127.0.0.1:${port}/ws/collab/${encodeURIComponent(ROOM)}`;
}, 180_000);

afterAll(async () => {
  registry.disposeAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mint(): string {
  return tickets.issueTicket({
    roomId: ROOM, userId: U, subject: "user", role: "editor", nick: "u1", color: "#2563EB",
  }).ticket;
}

/**
 * 建一条连上的客户端；返回它的 Awareness（用于手工组 awareness 帧）与收帧收集器。
 *
 * ★ 收集器必须在 **建连的同时** 挂上：服务端是「连上即推」（sync step1 + awareness
 * 快照），等 open 之后再 addEventListener 会把这批帧整批丢掉 —— 本测试最初就是这么
 * 误判成「快照没下发」的。
 */
function connect(): Promise<{ ws: WebSocket; awareness: Awareness; seen: () => number[] }> {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalStateField("user", {
    id: String(doc.clientID), kind: "user", userId: U, nick: "u1", color: "#2563EB",
  });
  const ws = new WebSocket(`${baseWs}?t=${encodeURIComponent(mint())}`);
  const ids: number[] = [];
  ws.on("message", (data: Buffer) => {
    const frame = new Uint8Array(data);
    if (frame[0] !== MSG.AWARENESS) return;
    const payload = readAwarenessPayload(frame);
    if (!payload) return;
    ids.push(...awarenessClientIds(payload));
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, awareness, seen: () => ids }));
    ws.on("error", reject);
  });
}

/** 按房间侧同一套线格组一条 awareness 帧：varUint(MSG.AWARENESS) + varUint(len) + payload。 */
function awarenessFrame(awareness: Awareness, clientId: number): Buffer {
  const payload = encodeAwarenessUpdate(awareness, [clientId]);
  return Buffer.from(concatBytes([varUintBytes(MSG.AWARENESS), varUintBytes(payload.length), payload]));
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("attach · 建连即下发 awareness 快照", () => {
  it("后加入的连接不发 queryAwareness 也能收到已在线者的名单", async () => {
    const first = await connect();
    first.ws.send(awarenessFrame(first.awareness, first.awareness.doc.clientID));
    // 等服务端把第一个人的 awareness 应用进房间
    await wait(300);
    expect(registry.presenceOf(ROOM).map((e) => e.id)).toContain(String(first.awareness.doc.clientID));

    // 第二个人只连上、什么也不发（模拟 y-websocket 的真实行为：不会主动 queryAwareness）
    const second = await connect();
    await wait(600);

    expect(second.seen()).toContain(first.awareness.doc.clientID);

    first.ws.close();
    second.ws.close();
    await wait(100);
  });

  it("房间无人时建连不会收到空壳 awareness 条目（服务端自身不是参与者）", async () => {
    const solo = await connect();
    await wait(400);
    // 服务端的 localState 是 null，不该被当成一条 presence 发下来
    expect(solo.seen()).toEqual([]);
    solo.ws.close();
    await wait(100);
  });
});
