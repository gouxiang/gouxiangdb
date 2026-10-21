// apps/api/src/collab/__tests__/canvasFlush.test.ts
// 画布冷归结的硬验收（真迁移临时库 + 主库 raw SQL 直查），与 docFlush.test.ts 同夹具。
//
// 覆盖：
//   T1 order/elements/texts（key 带 clientId 前缀）-> flush -> kb_docs.content 是可被
//      parseBoardContent 解析的 PlaitElement[] JSON、contentVersion+1、有自动快照、文本回填
//   T2 坏 / 未知类型元素被跳过且不炸，其余元素正常入库
//   T3 非 canvas kind（doc roomId）-> skipped，不碰库
//   T4 无最后编辑者 -> skipped；空 order（未播种）-> skipped
//   T5 冷归结撞 VersionConflict -> 三方归并回 Y、推进 baseVersion、重试一次后两边改动都在
//   T6 injectCanvasContent：在线房间的整篇覆盖写注入 CRDT 并由房间统一落库
//   T7 flusher 抛错 -> dirty/coldDirty 保留 + 退避，不静默（照搬 docFlush T5）

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import * as Y from "yjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { parseBoardContent } from "@gx/canvas";
import type { CollabConn } from "../room.js";

// 注意：canvasFlush.js 静态链路上有 db.js，只能在 beforeAll 注入临时 DATABASE_URL 后动态 import
// （同 docFlush.test.ts）。故这里本地固化 Y 键名，不静态 import canvasFlush 的常量。
const Y_ORDER_KEY = "order";
const Y_ELEMENTS_KEY = "elements";
const Y_TEXTS_KEY = "texts";

// db 单例必须在注入临时 DATABASE_URL 之后才实例化（同 docFlush.test.ts）。
type FlushMod = typeof import("../canvasFlush.js");
type RegistryMod = typeof import("../registry.js");
type RoomMod = typeof import("../room.js");
type KbWriteMod = typeof import("../../domain/kbDocWrite.js");
type KbMod = typeof import("../../domain/kb.js");

const U = "u1";
const OTHER = "u2";

let tmpDir: string;
type CanvasRoom = InstanceType<RoomMod["CollabRoom"]>;

let prisma: PrismaClient;
let flush: FlushMod;
let registry: RegistryMod;
let roomMod: RoomMod;
let kbWrite: KbWriteMod;
let kb: KbMod;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-canvas-flush-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "r.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  (globalThis as { __gx_prisma?: PrismaClient }).__gx_prisma = prisma;
  [flush, registry, roomMod, kbWrite, kb] = await Promise.all([
    import("../canvasFlush.js"),
    import("../registry.js"),
    import("../room.js"),
    import("../../domain/kbDocWrite.js"),
    import("../../domain/kb.js"),
  ]);
  flush.registerCanvasFlusher();

  await prisma.user.create({ data: { id: U, email: "u1@x.com", displayName: "u1", passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" } });
  await prisma.user.create({ data: { id: OTHER, email: "u2@x.com", displayName: "u2", passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" } });
  await prisma.knowledgeBase.create({ data: { id: "kb1", name: "知识库一", createdBy: U } });
}, 180_000);

afterAll(async () => {
  registry.disposeAll();
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function dbRow(docId: string): Promise<{
  content: string; searchText: string; contentVersion: number; updatedBy: string;
}> {
  const rows = await prisma.$queryRawUnsafe<{
    content: string; searchText: string; contentVersion: number; updatedBy: string;
  }[]>(
    'SELECT "content", "searchText", "contentVersion", "updatedBy" FROM "kb_docs" WHERE "id" = ?',
    docId,
  );
  const row = rows[0];
  if (!row) throw new Error(`kb_docs 里查不到 ${docId}`);
  return row;
}

async function makeCanvas(content: string): Promise<string> {
  const doc = await prisma.kbDoc.create({
    data: { kbId: "kb1", kind: "canvas", title: "画布", content, createdBy: U, updatedBy: U },
  });
  return doc.id;
}

function fakeConn(userId: string): CollabConn {
  return {
    id: "c1",
    ws: { readyState: 1, send: () => undefined, close: () => undefined, ping: () => undefined, terminate: () => undefined },
    subject: "user", userId, role: "editor", nick: userId, color: "#2563EB", alive: true,
  };
}

interface SeedEl {
  key: string;
  id: string;
  type: string;
  shape?: string;
  points?: number[][];
  /** 标准单段文本：作为 Y.Text 承载，属性 map 留段落骨架。 */
  text?: string;
  /** 富文本（带 marks）：不进 Y.Text，原样留在属性 map（往返无损）。 */
  richText?: unknown;
}

/** 模拟前端画布 binding：把元素按契约铺进房间 Y.Doc。 */
function seedBoard(room: CanvasRoom, els: SeedEl[]): void {
  room.doc.transact(() => {
    const order = room.doc.getArray<string>(Y_ORDER_KEY);
    const elements = room.doc.getMap<Y.Map<unknown>>(Y_ELEMENTS_KEY);
    const texts = room.doc.getMap<Y.Text>(Y_TEXTS_KEY);
    els.forEach((el, i) => {
      const m = new Y.Map<unknown>();
      m.set("id", el.id);
      m.set("type", el.type);
      if (el.shape) m.set("shape", el.shape);
      if (el.points) m.set("points", el.points);
      if (el.text !== undefined) {
        m.set("text", { type: "paragraph" });
        texts.set(el.key, new Y.Text(el.text));
      }
      if (el.richText !== undefined) m.set("text", el.richText);
      elements.set(el.key, m);
      order.insert(i, [el.key]);
    });
  }, null);
  // 播种事务 origin 是 null，lastEditor 不被 update 事件认领；用例自行按需设置。
  room.lastEditorUserId = U;
}

const rect = (id: string, text?: string, points: number[][] = [[0, 0], [100, 60]]): SeedEl => ({
  key: `7:${id}`, id, type: "geometry", shape: "rectangle", points, text,
});

describe("画布冷归结", () => {
  it("T1 Y 图元 -> flush -> 主库 content/searchText/contentVersion/updatedBy 全部更新 + 快照", async () => {
    const docId = await makeCanvas("");
    const room = await registry.acquireRoom(`canvas:${docId}`);
    expect(room).not.toBeNull();
    room!.addConn(fakeConn(U));
    seedBoard(room!, [rect("r1", "节点一"), rect("r2", "节点二")]);

    const res = await flush.flushCanvasRoom(room!);
    expect(res.status).toBe("written");

    const row = await dbRow(docId);
    const parsed = parseBoardContent(row.content);
    expect(parsed.parseError).toBe(false);
    expect(parsed.elements).toHaveLength(2);
    // 顺序按 order；clientId 前缀被剥掉，恢复业务 id
    expect(parsed.elements.map((e) => (e as { id: string }).id)).toEqual(["r1", "r2"]);
    // Y.Text 纯文本回填标准段落
    const first = parsed.elements[0] as { type: string; shape: string; text?: unknown };
    expect(first.type).toBe("geometry");
    expect(first.shape).toBe("rectangle");
    expect(first.text).toEqual({ type: "paragraph", children: [{ text: "节点一" }] });

    expect(row.contentVersion).toBe(1);
    expect(row.updatedBy).toBe(U);
    expect(row.searchText).toBe(kb.buildSearchText("canvas", row.content));
    expect(row.searchText).toContain("节点一");
    // 版本历史不留空洞：首写自动快照一份
    expect(await prisma.kbDocVersion.count({ where: { docId } })).toBe(1);
  });

  it("T1b 富文本（带 marks）不进 Y.Text，原样往返不丢样式", async () => {
    const docId = await makeCanvas("");
    const room = await registry.acquireRoom(`canvas:${docId}`);
    room!.addConn(fakeConn(U));
    const rich = { type: "paragraph", align: "center", children: [{ text: "加粗", bold: true }] };
    seedBoard(room!, [{ key: "9:z1", id: "z1", type: "geometry", shape: "ellipse", points: [[0, 0], [1, 1]], richText: rich }]);

    const res = await flush.flushCanvasRoom(room!);
    expect(res.status).toBe("written");

    const parsed = parseBoardContent((await dbRow(docId)).content);
    expect(parsed.elements[0]).toMatchObject({
      id: "z1",
      type: "geometry",
      shape: "ellipse",
      text: rich,
    });
  });

  it("T2 坏 / 未知类型元素被跳过且不炸，其余正常入库", async () => {
    const docId = await makeCanvas("");
    const room = await registry.acquireRoom(`canvas:${docId}`);
    room!.addConn(fakeConn(U));
    seedBoard(room!, [
      rect("ok1", "正常"),
      { key: "7:bad1", id: "bad1", type: "future-thing" }, // 未知类型 -> 跳过
      rect("ok2", "也正常"),
    ]);

    const res = await flush.flushCanvasRoom(room!);
    expect(res.status).toBe("written");

    const parsed = parseBoardContent((await dbRow(docId)).content);
    expect(parsed.elements.map((e) => (e as { id: string }).id)).toEqual(["ok1", "ok2"]);
  });

  it("T3 非 canvas kind（doc roomId）-> skipped，不碰库", async () => {
    const docId = await makeCanvas("");
    const docRoom = new roomMod.CollabRoom({
      roomId: `doc:${docId}`, kind: "doc", initialState: null, baseVersion: 0,
    });
    try {
      const res = await flush.flushCanvasRoom(docRoom);
      expect(res.status).toBe("skipped");
      expect(res.reason).toBe("not-canvas");
      // 未播种的画布内容仍是初始空串、版本 0
      expect((await dbRow(docId)).contentVersion).toBe(0);
    } finally {
      docRoom.destroy();
    }
  });

  it("T4 无最后编辑者 / 房间未播种 -> skipped 不写库", async () => {
    const docId = await makeCanvas("");
    const room = await registry.acquireRoom(`canvas:${docId}`);
    room!.addConn(fakeConn(U));

    // 空 Y（未播种）
    expect((await flush.flushCanvasRoom(room!)).reason).toBe("no-elements");

    seedBoard(room!, [rect("r1", "x")]);
    room!.lastEditorUserId = null;
    expect((await flush.flushCanvasRoom(room!)).reason).toBe("no-editor");

    expect((await dbRow(docId)).contentVersion).toBe(0);
    expect(await prisma.kbDocVersion.count({ where: { docId } })).toBe(0);
  });

  it("T5 外部整篇写推进过版本 -> 撞冲突 -> 三方归并后两边改动都在，baseVersion 收敛", async () => {
    const base = JSON.stringify([
      { id: "r1", type: "geometry", shape: "rectangle", points: [[0, 0], [100, 60]], text: { type: "paragraph", children: [{ text: "A" }] } },
    ]);
    const docId = await makeCanvas(base);
    const room = await registry.acquireRoom(`canvas:${docId}`);
    room!.addConn(fakeConn(U));
    seedBoard(room!, [rect("r1", "A")]);
    expect(room!.baseVersion).toBe(0);

    // 模拟绕过房间的外部整篇写：不动 r1，新增 r2（本地则在 r1 上改文本）
    const next = JSON.stringify([
      { id: "r1", type: "geometry", shape: "rectangle", points: [[0, 0], [100, 60]], text: { type: "paragraph", children: [{ text: "A" }] } },
      { id: "r2", type: "geometry", shape: "rectangle", points: [[200, 0], [300, 60]], text: { type: "paragraph", children: [{ text: "外部新增" }] } },
    ]);
    await (await import("../../db.js")).withWriteTx("doc.content.save", (tx) =>
      kbWrite.saveDocContentTx(tx, {
        docId, kind: "canvas", currentVersion: 0,
        content: next, searchText: kb.buildSearchText("canvas", next),
        userId: OTHER, baseVersion: 0,
      }),
    );
    expect((await dbRow(docId)).contentVersion).toBe(1);

    // 本地在 r1 上敲字（origin=conn，认领 lastEditor=U）
    const yt = room!.doc.getMap<Y.Text>(Y_TEXTS_KEY).get("7:r1");
    expect(yt).toBeDefined();
    room!.doc.transact(() => yt!.insert(yt!.length, "+协同"), fakeConn(U));

    const res = await flush.flushCanvasRoom(room!);
    expect(res.status).toBe("written");
    expect(res.contentVersion).toBe(2); // 冲突重试一次才落库

    const parsed = parseBoardContent((await dbRow(docId)).content);
    const ids = parsed.elements.map((e) => (e as { id: string }).id).sort();
    expect(ids).toEqual(["r1", "r2"]); // 外部新增没丢
    const r1 = parsed.elements.find((e) => (e as { id: string }).id === "r1") as { text?: { children: [{ text: string }] } };
    expect(r1.text?.children[0]?.text).toBe("A+协同"); // 在线编辑没被吞
    expect(room!.baseVersion).toBe(2);
  });

  it("T6 房间在线时整篇覆盖写走 CRDT 注入：房间 Y 与主库收敛，actor 归 PUT 侧", async () => {
    const base = JSON.stringify([
      { id: "r1", type: "geometry", shape: "rectangle", points: [[0, 0], [100, 60]], text: { type: "paragraph", children: [{ text: "旧" }] } },
    ]);
    const docId = await makeCanvas(base);
    const room = await registry.acquireRoom(`canvas:${docId}`);
    room!.addConn(fakeConn(U));
    seedBoard(room!, [rect("r1", "旧")]);

    const injectedJson = JSON.stringify([
      { id: "r1", type: "geometry", shape: "rectangle", points: [[0, 0], [100, 60]], text: { type: "paragraph", children: [{ text: "注入的新文本" }] } },
    ]);
    const res = await flush.injectCanvasContent(room!, injectedJson, OTHER);
    expect(res.injected).toBe(true);
    expect(res.contentVersion).toBe(1);

    // Y 已收敛：再从 Y 还原得到的就是注入内容
    const rehydrated = flush.readBoardFromY(room!.doc).board;
    expect(rehydrated[0]).toMatchObject({ id: "r1", text: { type: "paragraph", children: [{ text: "注入的新文本" }] } });

    const row = await dbRow(docId);
    // 库内容与 Y 还原逐结构相等（不比较对象键序）
    expect(parseBoardContent(row.content).elements).toEqual(rehydrated);
    expect(row.updatedBy).toBe(OTHER);
  });

  it("T6b 房间未播种 / 坏画布 JSON -> injected=false，调用方退回直写", async () => {
    const docId = await makeCanvas("");
    const room = await registry.acquireRoom(`canvas:${docId}`);
    room!.addConn(fakeConn(U));
    // 未播种
    expect((await flush.injectCanvasContent(room!, "[]", U)).injected).toBe(false);

    seedBoard(room!, [rect("r1", "x")]);
    // 已播种但入参坏 JSON -> 不污染在线房间
    expect((await flush.injectCanvasContent(room!, "{不是JSON", U)).injected).toBe(false);
    expect(flush.readBoardFromY(room!.doc).board.map((e) => (e as { id: string }).id)).toEqual(["r1"]);
  });

  it("T7 归结失败 -> 保留 dirty/coldDirty + 退避 + 显式日志（不静默）", async () => {
    const docId = await makeCanvas("");
    const room = await registry.acquireRoom(`canvas:${docId}`);
    expect(room).not.toBeNull();
    room!.addConn(fakeConn(U));
    seedBoard(room!, [rect("r1", "x")]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await prisma.$executeRawUnsafe('ALTER TABLE "kb_docs" RENAME TO "kb_docs_bak"');
    try {
      await expect(room!.flush("tick")).resolves.toBeUndefined();
      expect(room!.dirty).toBe(true);
      expect(room!.coldDirty).toBe(true);
      expect(errSpy).toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("[collab]");
      // 退避：紧接着再归结被挡住
      expect((await flush.flushCanvasRoom(room!)).status).toBe("deferred");
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "kb_docs_bak" RENAME TO "kb_docs"');
    }
    // 恢复 + 房间空置（强制落盘）后正常写道
    room!.removeConn([...room!.conns][0]!);
    await expect(flush.flushCanvasRoom(room!)).resolves.toMatchObject({ status: "written" });
    errSpy.mockRestore();
  });
});
