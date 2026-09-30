// apps/api/src/collab/__tests__/docFlush.test.ts
// 文档冷归结的**硬验收**（真迁移临时库 + 主库 raw SQL 直查，不看返回值就算过关）。
//
// 覆盖 DESIGN §2.3 冷归结五条硬约束中的 ①③④ 与 §3.2 / §3.3：
//   T1 协同改动 -> 归结 -> kb_docs.content/searchText/contentVersion/updatedBy 全部更新
//   T2 房间持旧 base_version 期间被整篇覆盖写推进过版本 -> 撞冲突 -> 重试后两边改动都在
//   T3 房间在线时 PUT -> 走 CRDT 注入（断言 Y 收到了这次更新），不写库
//   T4 房间不在线时 PUT -> 与今天逐字节一致（回归保护）
//   T5 归结失败 -> 保留 dirty + 退避 + 显式日志，绝不静默

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { blocksToMd, mdToBlocks } from "@gx/blocks";
import { docBlocksOf, hydrateDocBlocks, markdownToBlocks, blocksToMarkdown } from "../docYjs.js";
import { syncDocBlocksToY } from "../docMerge.js";
import type { CollabConn } from "../room.js";

// 注意：只能 type-only import 或 beforeAll 内动态 import —— 静态 import 会让 db 单例在
// 注入临时 DATABASE_URL / globalThis.__gx_prisma 之前实例化，绑错库。
type FlushMod = typeof import("../docFlush.js");
type RegistryMod = typeof import("../registry.js");
type KbWriteMod = typeof import("../../domain/kbDocWrite.js");
type KbMod = typeof import("../../domain/kb.js");
type AuthMod = typeof import("../../domain/org/authState.js");

const U = "u1";
const OTHER = "u2";
/** 三块：标题 / 第一段 / 第二段。房间与 HTTP 两侧各改一块，互不重叠 —— 便于断言"谁也没丢"。 */
const MD_A = "# 标题\n\n第一段\n\n第二段";
/** 外部整篇覆盖写：只动第二段。 */
const MD_B = "# 标题\n\n第一段\n\n第二段（HTTP加）";

let tmpDir: string;
let prisma: PrismaClient;
let flush: FlushMod;
let registry: RegistryMod;
let kbWrite: KbWriteMod;
let kb: KbMod;
let auth: AuthMod;
let app: Hono;
let token: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-collab-flush-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "r.db")}`;
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_DATA_DIR = tmpDir;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  (globalThis as { __gx_prisma?: PrismaClient }).__gx_prisma = prisma;
  [flush, registry, kbWrite, kb, auth] = await Promise.all([
    import("../docFlush.js"),
    import("../registry.js"),
    import("../../domain/kbDocWrite.js"),
    import("../../domain/kb.js"),
    import("../../domain/org/authState.js"),
  ]);
  const docs = await import("../../routes/kb/docs.js");
  flush.registerDocFlusher();

  await prisma.user.create({ data: { id: U, email: "u1@x.com", displayName: "u1", passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" } });
  await prisma.user.create({ data: { id: OTHER, email: "u2@x.com", displayName: "u2", passwordHash: "x", status: "ACTIVE", workspaceId: "ws_default" } });
  // 超级管理员角色 -> resolveKbAccess 走 SUPER_ACCESS 短路（否则要铺一整套 scope 配置）。
  // role_owner 可能已由迁移种子行建好（唯一键在工作区+名称上），故 upsert。
  await prisma.role.upsert({
    where: { id: "role_owner" },
    create: { id: "role_owner", workspaceId: "ws_default", systemKey: "owner", name: "超级管理员", isSystem: 1 },
    update: {},
  });
  await prisma.roleAssignment.create({ data: { roleId: "role_owner", subjectType: "user", subjectId: U } });
  await prisma.knowledgeBase.create({ data: { id: "kb1", name: "知识库一", createdBy: U } });

  app = new Hono();
  app.route("/api/kb", docs.docsRoutes);
  token = await auth.issueToken(U);
}, 180_000);

afterAll(async () => {
  registry.disposeAll();
  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 主库直查（raw SQL，不走 ORM 模型，也不看函数返回值）。 */
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

async function makeDoc(content: string): Promise<string> {
  const doc = await prisma.kbDoc.create({
    data: { kbId: "kb1", kind: "doc", title: "文档", content, createdBy: U, updatedBy: U },
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

/** 模拟客户端：连上 -> 播种（seedBlocks 等价）-> 在某一块尾部敲几个字。 */
async function onlineRoomWithEdit(docId: string, md: string, editIndex: number, insert: string) {
  const room = await registry.acquireRoom(`doc:${docId}`);
  if (!room) throw new Error("房间没建起来");
  const conn = fakeConn(U);
  room.addConn(conn);
  const b = docBlocksOf(room.doc);
  room.doc.transact(() => syncDocBlocksToY(b, markdownToBlocks(md)), null);
  const id = b.order.toArray()[editIndex];
  const yt = b.texts.get(id);
  if (!yt) throw new Error(`块 ${editIndex} 不存在`);
  room.doc.transact(() => yt.insert(yt.length, insert), conn);
  return { room, b, conn };
}

/** 模拟"打开协同、一个字都没改"的客户端：连上 -> 播种（seedBlocks 等价），不产生任何编辑。 */
async function openRoomWithoutEdit(docId: string, md: string) {
  const room = await registry.acquireRoom(`doc:${docId}`);
  if (!room) throw new Error("房间没建起来");
  room.addConn(fakeConn(U));
  const b = docBlocksOf(room.doc);
  room.doc.transact(() => syncDocBlocksToY(b, markdownToBlocks(md)), null);
  // 播种事务 origin 是 null（不是连接），lastEditor 不会被 update 事件认领；这里显式记上，
  // 与 injectDocContent 的做法一致 —— 否则 flush 会先在"无最后编辑者"处 skipped，
  // 掩盖掉本用例真正要验的"内容未变则不写库"判定。
  room.lastEditorUserId = U;
  return { room, b };
}

function mdOf(b: ReturnType<typeof docBlocksOf>): string {
  return blocksToMarkdown(hydrateDocBlocks(b));
}

async function putContent(docId: string, content: string, baseVersion?: number) {
  return await app.request(`/api/kb/docs/${docId}/content`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-GX-Token": token },
    body: JSON.stringify({ content, ...(baseVersion === undefined ? {} : { baseVersion }) }),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("文档冷归结", () => {
  it("T1 协同改动 -> 归结 -> 主库 content/searchText/contentVersion/updatedBy 全部更新", async () => {
    const docId = await makeDoc(MD_A);
    const { room, b } = await onlineRoomWithEdit(docId, MD_A, 1, "（协同改）");
    expect(room.lastEditorUserId).toBe(U);

    const res = await flush.flushDocRoom(room);
    expect(res.status).toBe("written");

    const row = await dbRow(docId);
    expect(row.content).toContain("第一段（协同改）");
    expect(row.content).toBe(mdOf(b));           // 主库内容 == 房间 Y 的内容（无二次失真）
    expect(row.contentVersion).toBe(1);
    expect(row.updatedBy).toBe(U);               // ① 记的是最后编辑者的真实 userId
    expect(row.searchText).toBe(kb.buildSearchText("doc", row.content));
    expect(row.searchText).toContain("协同改");
    expect(row.searchText).not.toContain("#");   // searchText 是去标记的纯文本
    // 版本历史不留空洞：自动快照照旧落了一份
    expect(await prisma.kbDocVersion.count({ where: { docId } })).toBe(1);
  });

  it("T2 房间持旧 base_version 期间被整篇覆盖写推进过版本 -> 撞冲突 -> 重试后两边改动都在", async () => {
    const docId = await makeDoc(MD_A);
    const { room, b } = await onlineRoomWithEdit(docId, MD_A, 1, "（协同改）");
    expect(room.baseVersion).toBe(0);

    // 模拟一次绕过房间的整篇覆盖写（MCP / 房间空置期的 PUT 都走这条既有事务体）
    await (await import("../../db.js")).withWriteTx("doc.content.save", (tx) =>
      kbWrite.saveDocContentTx(tx, {
        docId, kind: "doc", currentVersion: 0,
        content: MD_B, searchText: kb.buildSearchText("doc", MD_B),
        userId: OTHER, baseVersion: 0,
      }),
    );
    expect((await dbRow(docId)).contentVersion).toBe(1);

    const res = await flush.flushDocRoom(room);
    expect(res.status).toBe("written");
    expect(res.contentVersion).toBe(2);          // 冲突后重试一次才落库，不是终态

    const row = await dbRow(docId);
    expect(row.content).toContain("（协同改）");   // 协同侧的改动没被吞
    expect(row.content).toContain("（HTTP加）");   // 外部写入的改动也没被吞
    expect(row.content).toBe(mdOf(b));
    expect(room.baseVersion).toBe(2);
  });

  it("T3 房间在线时 PUT -> 走 CRDT 注入（ rooms 的 Y 收到这次更新），不直接写库", async () => {
    const docId = await makeDoc(MD_A);
    const { room: _room, b } = await onlineRoomWithEdit(docId, MD_A, 1, "（协同改）");
    const before = mdOf(b);
    expect(before).toContain("（协同改）");

    const res = await putContent(docId, MD_B, 0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; contentVersion: number | null };
    expect(body.ok).toBe(true);
    expect(body.contentVersion).toBe(1);

    // 房间收到了这次更新：只有注入会动 Y.Doc —— 直接写库永远改不到 Y。
    const after = mdOf(b);
    expect(after).not.toBe(before);
    expect(after).toContain("（HTTP加）");
    expect(after).toContain("（协同改）");         // 注入不抹掉在线编辑

    const row = await dbRow(docId);
    expect(row.content).toBe(after);             // 由房间统一归结落库，两边收敛
    expect(row.contentVersion).toBe(1);
    expect(row.updatedBy).toBe(U);               // updatedBy 归这次 PUT 的 actor
  });

  it("T4 房间不在线时 PUT -> 与今天逐字节一致（不经过任何 CRDT 重序列化）", async () => {
    const docId = await makeDoc(MD_A);
    // 房间存在但无人在线（最后一人已离开、尚未销毁的空房间）
    const room = await registry.acquireRoom(`doc:${docId}`);
    expect(room).not.toBeNull();
    expect(registry.onlineRoom(`doc:${docId}`)).toBeNull();

    // 带多余空行的正文：若走注入会被 mdToBlocks->blocksToMd 重序列化掉，逐字相等不成立。
    const exact = `${MD_B}\n\n\n`;
    expect(blocksToMd(mdToBlocks(exact))).not.toBe(exact); // 前提：重序列化确实会改字节

    const res = await putContent(docId, exact, 0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["contentVersion", "ok", "savedAt", "snapshotted"]);
    expect(body.ok).toBe(true);
    expect(body.snapshotted).toBe(true);
    expect(body.contentVersion).toBe(1);

    const row = await dbRow(docId);
    expect(row.content).toBe(exact);                              // 逐字节
    expect(row.searchText).toBe(kb.buildSearchText("doc", exact));
    expect(row.contentVersion).toBe(1);
    expect(row.updatedBy).toBe(U);
    // 房间的 Y 没被动过 —— 证明没走注入（注入会把这次正文铺进 Y）
    expect(docBlocksOf(room!.doc).order.length).toBe(0);
  });

  it("T6 最后一人离开（registry.releaseConn）-> 空置归结立即落盘", async () => {
    const docId = await makeDoc(MD_A);
    const { room } = await onlineRoomWithEdit(docId, MD_A, 1, "（协同改）");
    const conn = [...room.conns][0] as CollabConn;
    registry.releaseConn(room, conn);
    // releaseConn 内部是 fire-and-forget 的空置归结，给它一轮事件循环。
    await new Promise((r) => setTimeout(r, 100));
    const row = await dbRow(docId);
    expect(row.content).toContain("（协同改）");
    expect(row.contentVersion).toBe(1);
    expect(row.updatedBy).toBe(U);
  });

  it("T7 库里正文与 Y 还原正文只差行尾换行 -> unchanged，不写库 / 不递增版本 / 不产生快照", async () => {
    // 库里存的正文形态：一个尾换行都没有（HTTP/MCP 直写进来的就是这种），以及多带了几个。
    // 两种都必须判为"未变"—— 归因见 docFlush.sameDocContent 的注释：
    // blocksToMd 的出口恒定带一个行尾换行，逐字节比会把"什么都没改"误判成改动。
    for (const stored of ["# 标题", "# 标题\n\n\n"]) {
      const docId = await makeDoc(stored);
      const { room, b } = await openRoomWithoutEdit(docId, "# 标题");

      // 前提：还原出的正文恒定带一个尾换行，与库里存的内容逐字节不等（缺陷成因）
      expect(mdOf(b)).toBe("# 标题\n");
      expect(mdOf(b)).not.toBe(stored);

      const res = await flush.flushDocRoom(room);
      expect(res.status).toBe("unchanged");
      expect(res.snapshotted).toBe(false);
      expect(res.contentVersion).toBe(0);

      const row = await dbRow(docId);
      expect(row.content).toBe(stored);              // 库里正文一个字节都没动
      expect(row.contentVersion).toBe(0);            // 版本号没被顶上去
      expect(await prisma.kbDocVersion.count({ where: { docId } })).toBe(0); // 无零差异快照
    }
  });

  it("T7b sameDocContent 边界：只忽略行尾换行，正文内的差异与 CRLF 差异照旧算改动", () => {
    expect(flush.sameDocContent("# 标题", "# 标题\n")).toBe(true);
    expect(flush.sameDocContent("# 标题\n\n\n", "# 标题\n")).toBe(true);
    expect(flush.sameDocContent("# 标题\n", "# 标题")).toBe(true);
    expect(flush.sameDocContent("", "\n")).toBe(true);
    expect(flush.sameDocContent("# 标题", "# 标题2\n")).toBe(false);   // 真改动
    expect(flush.sameDocContent("# 标题\n\n中段", "# 标题中段\n")).toBe(false); // 正文内的换行
    expect(flush.sameDocContent("# 标题\r\n", "# 标题\n")).toBe(false); // CRLF 不在此豁免范围
  });

  it("T8 真实改动仍然写库（防止把判定改成「永远不变」的假绿）", async () => {
    const stored = "# 标题";                          // 同样是无尾换行的库内容
    const docId = await makeDoc(stored);
    const { room, b } = await openRoomWithoutEdit(docId, stored);
    const yt = b.texts.get(b.order.toArray()[0]!);
    if (!yt) throw new Error("块不存在");
    room.doc.transact(() => yt.insert(yt.length, "（真改）"), [...room.conns][0] as CollabConn);

    const res = await flush.flushDocRoom(room);
    expect(res.status).toBe("written");
    expect(res.contentVersion).toBe(1);

    const row = await dbRow(docId);
    expect(row.content).toBe(mdOf(b));
    expect(row.content).toContain("（真改）");
    expect(row.contentVersion).toBe(1);
    expect(await prisma.kbDocVersion.count({ where: { docId } })).toBe(1);
  });

  it("T5 归结失败 -> 保留 dirty + 退避 + 显式日志（不静默）", async () => {
    const docId = await makeDoc(MD_A);
    const { room } = await onlineRoomWithEdit(docId, MD_A, 1, "（协同改）");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // 把主库表挪走制造真实的写失败（比 DROP 安全，结束即还原）
    await prisma.$executeRawUnsafe('ALTER TABLE "kb_docs" RENAME TO "kb_docs_bak"');
    try {
      // room.flush 是 registry 的三条触发路径共用的入口：失败不得冒成未捕获异常
      await expect(room.flush("tick")).resolves.toBeUndefined();
      expect(room.dirty).toBe(true);                       // dirty 保留，下一轮还会再试
      expect(errSpy).toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0]?.[0])).toContain("[collab] flush failed");
      // 退避：紧接着再归结一次会被挡住，而不是无限重试打爆队列
      expect((await flush.flushDocRoom(room)).status).toBe("deferred");
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "kb_docs_bak" RENAME TO "kb_docs"');
    }
    // 恢复后（且房间已清空 -> 强制落盘）能正常写道
    room.removeConn([...room.conns][0] as CollabConn);
    await expect(flush.flushDocRoom(room)).resolves.toMatchObject({ status: "written" });
  });
});
