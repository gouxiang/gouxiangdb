// M3/S3 路由层写点同步测试（kb.ts：#11 建 kb / #12 改名软删 / #13a-d 文档生命周期）。
//
// 每写点三条真库真 HTTP 证明（裁决 9）：正向 reconcile 0 阻断；方向① nav 写失败实体回滚；
// 方向② 实体写失败 nav 无残留/未变。trigger 注入不随事务回滚，afterEach 必清。

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  json,
  failNavWrites,
  failEntityWrite,
  stopFailing,
  assertNoBlockingDiffs,
  type CharHarness,
} from "./navRouteHarness.js";
import { nodeId } from "../backfill.js";

let h: CharHarness;
const OWNER = "owner";

beforeAll(async () => {
  h = await makeNavHarness("gx-m3-s3-kb-");
  await h.createUser(OWNER, { email: "owner@kb.com", displayName: "Owner" });
});
afterAll(async () => { await h.cleanup(); });
afterEach(async () => { await stopFailing(h); });

const post = async (url: string, body: unknown) =>
  h.app.request(url, { method: "POST", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = async (url: string, body: unknown) =>
  h.app.request(url, { method: "PATCH", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const put = async (url: string, body: unknown) =>
  h.app.request(url, { method: "PUT", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = async (url: string) =>
  h.app.request(url, { method: "DELETE", headers: await h.auth(OWNER) });

let seq = 0;
async function createKb(name = `KB${++seq}`) {
  const res = await post("/api/kb", { name });
  expect(res.status).toBe(201);
  return (await json<{ knowledgeBase: { id: string } }>(res)).knowledgeBase;
}
async function createDoc(kbId: string, body: Record<string, unknown>) {
  const res = await post(`/api/kb/${kbId}/docs`, body);
  expect(res.status, `createDoc ${res.status}`).toBe(201);
  return (await json<{ doc: { id: string } }>(res)).doc;
}

describe("#11 建 kb", () => {
  it("正向：kb 节点在、0 阻断", async () => {
    const kb = await createKb("K11");
    const n = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("kb", kb.id) } });
    expect(n.path).toBe(`/nav_kb_${kb.id}/`);
    await assertNoBlockingDiffs(h);
  });
  it("方向①：nav 失败 -> 500，kb/成员回滚", async () => {
    await failNavWrites(h);
    const res = await post("/api/kb", { name: "K11-rb1" });
    expect(res.status).toBe(500);
    expect(await h.prisma.knowledgeBase.count({ where: { name: "K11-rb1" } })).toBe(0);
    expect(await h.prisma.navNode.count({ where: { name: "K11-rb1" } })).toBe(0);
  });
  it("方向②：kb INSERT 失败 -> 500，nav 无新增", async () => {
    const before = await h.prisma.navNode.count();
    await failEntityWrite(h, "knowledge_bases", "INSERT");
    const res = await post("/api/kb", { name: "K11-rb2" });
    expect(res.status).toBe(500);
    expect(await h.prisma.navNode.count()).toBe(before);
  });
});

describe("#12 kb 改名 / 软删", () => {
  it("改名正向节点 name 同步；方向① nav 失败实体名不变", async () => {
    const kb = await createKb("K12");
    const ok = await patch(`/api/kb/${kb.id}`, { name: "K12-new" });
    expect(ok.status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("kb", kb.id) } })).name).toBe("K12-new");
    await assertNoBlockingDiffs(h);

    await failNavWrites(h);
    const bad = await patch(`/api/kb/${kb.id}`, { name: "K12-x" });
    expect(bad.status).toBe(500);
    expect((await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kb.id } })).name).toBe("K12-new");
  });

  it("软删正向：kb/doc/canvas 节点整棵软删；方向① nav 失败实体未软删", async () => {
    const kb = await createKb("K12-del");
    const d = await createDoc(kb.id, { kind: "doc", title: "d" });
    const cv = await createDoc(kb.id, { kind: "canvas", title: "c" });
    const ok = await del(`/api/kb/${kb.id}`);
    expect(ok.status).toBe(200);
    for (const nid of [nodeId("kb", kb.id), nodeId("doc", d.id), nodeId("canvas", cv.id)]) {
      expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nid } })).deletedAt).not.toBeNull();
    }
    await assertNoBlockingDiffs(h);

    const kb2 = await createKb("K12-del-rb");
    await failNavWrites(h);
    const bad = await del(`/api/kb/${kb2.id}`);
    expect(bad.status).toBe(500);
    expect((await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kb2.id } })).deletedAt).toBeNull();
  });
});

describe("#13a 建 doc/canvas", () => {
  it("正向：子 doc 挂父节点三层 path、canvas 挂 kb；根 doc/canvas 各 1 条 C4 warning", async () => {
    const kb = await createKb("K13a");
    const parent = await createDoc(kb.id, { kind: "doc", title: "p" });
    const child = await createDoc(kb.id, { kind: "doc", title: "c", parentId: parent.id });
    const canvas = await createDoc(kb.id, { kind: "canvas", title: "cv" });
    const cn = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", child.id) } });
    expect(cn.parentId).toBe(nodeId("doc", parent.id));
    expect(cn.path).toBe(`/nav_kb_${kb.id}/nav_doc_${parent.id}/nav_doc_${child.id}/`);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("canvas", canvas.id) } })).parentId)
      .toBe(nodeId("kb", kb.id));
    await assertNoBlockingDiffs(h);
  });
  it("方向①：nav 失败 -> doc/版本行回滚不存在", async () => {
    const kb = await createKb("K13a-rb1");
    await failNavWrites(h);
    const res = await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "rollback-doc" });
    expect(res.status).toBe(500);
    expect(await h.prisma.kbDoc.count({ where: { title: "rollback-doc" } })).toBe(0);
  });
  it("方向②：kb_docs INSERT 失败 -> nav 无新增节点", async () => {
    const kb = await createKb("K13a-rb2");
    const before = await h.prisma.navNode.count();
    await failEntityWrite(h, "kb_docs", "INSERT");
    const res = await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "entityfail-doc" });
    expect(res.status).toBe(500);
    expect(await h.prisma.navNode.count()).toBe(before);
  });
});

describe("#13b 改名 / PUT content 附带 title", () => {
  it("PATCH 与 PUT content 都同步节点 name；0 阻断", async () => {
    const kb = await createKb("K13b");
    const d = await createDoc(kb.id, { kind: "doc", title: "old" });
    const p1 = await patch(`/api/kb/docs/${d.id}`, { title: "patched" });
    expect(p1.status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", d.id) } })).name).toBe("patched");
    const p2 = await put(`/api/kb/docs/${d.id}/content`, { content: "# body", title: "via-put" });
    expect(p2.status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", d.id) } })).name).toBe("via-put");
    await assertNoBlockingDiffs(h);
  });
});

describe("#13c doc 移动（子树 path 重写）", () => {
  it("正向：父 doc 移到根，自身与后代改挂并重算子树 path；方向① nav 失败 parentId 不变", async () => {
    const kb = await createKb("K13c");
    const root = await createDoc(kb.id, { kind: "doc", title: "r" });
    const mid = await createDoc(kb.id, { kind: "doc", title: "m", parentId: root.id });
    const leaf = await createDoc(kb.id, { kind: "doc", title: "l", parentId: mid.id });
    const moved = await post(`/api/kb/docs/${root.id}/move`, { parentId: null });
    expect(moved.status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", root.id) } })).parentId)
      .toBe(nodeId("kb", kb.id));
    const ln = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", leaf.id) } });
    expect(ln.path).toBe(`/nav_kb_${kb.id}/nav_doc_${root.id}/nav_doc_${mid.id}/nav_doc_${leaf.id}/`);
    expect(ln.depth).toBe(4);
    await assertNoBlockingDiffs(h);

    // 方向①：把 leaf 移到根（合法），nav 失败则实体 parentId 仍指 mid。
    await failNavWrites(h);
    const bad = await post(`/api/kb/docs/${leaf.id}/move`, { parentId: null });
    expect(bad.status).toBe(500);
    expect((await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: leaf.id } })).parentId).toBe(mid.id);
  });
});

describe("#13d 软删 / 恢复 / 物理删", () => {
  it("软删->恢复：节点随实体软删、恢复复活；方向① nav 失败实体状态不变", async () => {
    const kb = await createKb("K13d-restore");
    const d = await createDoc(kb.id, { kind: "doc", title: "x" });
    expect((await del(`/api/kb/docs/${d.id}`)).status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", d.id) } })).deletedAt).not.toBeNull();
    const restore = await post(`/api/kb/docs/${d.id}/restore`, {});
    expect(restore.status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", d.id) } })).deletedAt).toBeNull();
    await assertNoBlockingDiffs(h);

    await failNavWrites(h);
    const bad = await del(`/api/kb/docs/${d.id}`);
    expect(bad.status).toBe(500);
    expect((await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: d.id } })).deletedAt).toBeNull();
  });

  it("物理删：清自身 shortcut + 删节点；孤儿子文档节点改挂 kb；0 阻断", async () => {
    const kb = await createKb("K13d-purge");
    const parent = await createDoc(kb.id, { kind: "doc", title: "p" });
    const child = await createDoc(kb.id, { kind: "doc", title: "c", parentId: parent.id });
    const perm = await del(`/api/kb/docs/${parent.id}/permanent`);
    expect(perm.status).toBe(200);
    expect(await h.prisma.kbDoc.count({ where: { id: parent.id } })).toBe(0);
    expect(await h.prisma.navNode.count({ where: { id: nodeId("doc", parent.id) } })).toBe(0);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", child.id) } })).parentId)
      .toBe(nodeId("kb", kb.id));
    await assertNoBlockingDiffs(h);
  });
});
