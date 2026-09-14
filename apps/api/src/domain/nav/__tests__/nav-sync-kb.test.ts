// M3/S3 路由层写点同步测试（kb.ts 容器与建内容：#11 建 kb / #12 改名软删 / #13a 建 doc,canvas）。
// 文档改名/内容/移动/软删/恢复/永久删见 nav-sync-kb-docs.test.ts。
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
  it("正向：kb 节点在、path 一层，0 阻断", async () => {
    const kb = await createKb(`K11-${++seq}`);
    const n = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("kb", kb.id) } });
    expect(n.path).toBe(`/nav_kb_${kb.id}/`);
    await assertNoBlockingDiffs(h);
  });
  it("方向①：nav 失败 -> 500，kb/成员回滚", async () => {
    const name = `K11-r1-${++seq}`;
    await failNavWrites(h);
    const res = await post("/api/kb", { name });
    expect(res.status).toBe(500);
    expect(await h.prisma.knowledgeBase.count({ where: { name } })).toBe(0);
    expect(await h.prisma.navNode.count({ where: { name } })).toBe(0);
  });
  it("方向②：knowledge_bases INSERT 失败 -> 500，nav 无新增", async () => {
    const before = await h.prisma.navNode.count();
    await failEntityWrite(h, "knowledge_bases", "INSERT");
    const res = await post("/api/kb", { name: `K11-r2-${++seq}` });
    expect(res.status).toBe(500);
    expect(await h.prisma.navNode.count()).toBe(before);
  });
});

describe("#12a kb 改名", () => {
  it("正向：节点 name 同步，0 阻断", async () => {
    const kb = await createKb(`K12-${++seq}`);
    const ok = await patch(`/api/kb/${kb.id}`, { name: "K12-new" });
    expect(ok.status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("kb", kb.id) } })).name).toBe("K12-new");
    await assertNoBlockingDiffs(h);
  });
  it("方向①：nav 失败 -> 500，实体名不变", async () => {
    const kb = await createKb(`K12-r1-${++seq}`);
    await failNavWrites(h);
    const bad = await patch(`/api/kb/${kb.id}`, { name: "不该落" });
    expect(bad.status).toBe(500);
    expect((await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kb.id } })).name).not.toBe("不该落");
  });
  it("方向②：knowledge_bases UPDATE 失败 -> 500，节点名不变", async () => {
    const kb = await createKb(`K12-r2-${++seq}`);
    const before = (await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("kb", kb.id) } })).name;
    await failEntityWrite(h, "knowledge_bases", "UPDATE");
    const bad = await patch(`/api/kb/${kb.id}`, { name: "实体失败" });
    expect(bad.status).toBe(500);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("kb", kb.id) } })).name).toBe(before);
  });
});

describe("#12b kb 软删（整棵子树节点软删）", () => {
  it("正向：kb/doc/canvas 节点全软删（行保留），0 阻断", async () => {
    const kb = await createKb(`K12d-${++seq}`);
    const d = await createDoc(kb.id, { kind: "doc", title: "d" });
    const cv = await createDoc(kb.id, { kind: "canvas", title: "c" });
    const ok = await del(`/api/kb/${kb.id}`);
    expect(ok.status).toBe(200);
    for (const nid of [nodeId("kb", kb.id), nodeId("doc", d.id), nodeId("canvas", cv.id)]) {
      expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nid } })).deletedAt).not.toBeNull();
    }
    expect((await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kb.id } })).deletedAt).not.toBeNull();
    await assertNoBlockingDiffs(h);
  });
  it("方向①：nav 失败 -> 500，kb/docs 未软删", async () => {
    const kb = await createKb(`K12d-r1-${++seq}`);
    await createDoc(kb.id, { kind: "doc", title: "d" });
    await failNavWrites(h);
    const bad = await del(`/api/kb/${kb.id}`);
    expect(bad.status).toBe(500);
    expect((await h.prisma.knowledgeBase.findUniqueOrThrow({ where: { id: kb.id } })).deletedAt).toBeNull();
    expect(await h.prisma.kbDoc.count({ where: { kbId: kb.id, deletedAt: { not: null } } })).toBe(0);
  });
  it("方向②：knowledge_bases UPDATE 失败 -> 500，nav 子树仍活", async () => {
    const kb = await createKb(`K12d-r2-${++seq}`);
    const d = await createDoc(kb.id, { kind: "doc", title: "d" });
    await failEntityWrite(h, "knowledge_bases", "UPDATE");
    const bad = await del(`/api/kb/${kb.id}`);
    expect(bad.status).toBe(500);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("kb", kb.id) } })).deletedAt).toBeNull();
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", d.id) } })).deletedAt).toBeNull();
  });
});

describe("#13a 建 doc/canvas（+首版本）", () => {
  it("正向：子 doc 挂父节点三层 path、canvas 挂 kb；根 doc/canvas 各 1 条 C4 warning", async () => {
    const kb = await createKb(`K13a-${++seq}`);
    const parent = await createDoc(kb.id, { kind: "doc", title: "p" });
    const child = await createDoc(kb.id, { kind: "doc", title: "c", parentId: parent.id });
    const canvas = await createDoc(kb.id, { kind: "canvas", title: "cv" });
    const cn = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", child.id) } });
    expect(cn.parentId).toBe(nodeId("doc", parent.id));
    expect(cn.path).toBe(`/nav_kb_${kb.id}/nav_doc_${parent.id}/nav_doc_${child.id}/`);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("canvas", canvas.id) } })).parentId)
      .toBe(nodeId("kb", kb.id));
    // 首版本同事务落库（强一致证明的一部分：回滚时版本也无）。
    expect(await h.prisma.kbDocVersion.count({ where: { docId: parent.id } })).toBe(1);
    await assertNoBlockingDiffs(h);
  });
  it("方向①：nav 失败 -> 500，doc/首版本回滚不存在", async () => {
    const kb = await createKb(`K13a-r1-${++seq}`);
    const title = `rollback-doc-${++seq}`;
    const vBefore = await h.prisma.kbDocVersion.count();
    await failNavWrites(h);
    const res = await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title });
    expect(res.status).toBe(500);
    expect(await h.prisma.kbDoc.count({ where: { title } })).toBe(0);
    // 首版本与 doc 同事务，整体回滚，版本数不增。
    expect(await h.prisma.kbDocVersion.count()).toBe(vBefore);
  });
  it("方向②：kb_docs INSERT 失败 -> 500，nav 无新增节点、版本数不增", async () => {
    const kb = await createKb(`K13a-r2-${++seq}`);
    const nBefore = await h.prisma.navNode.count();
    const vBefore = await h.prisma.kbDocVersion.count();
    await failEntityWrite(h, "kb_docs", "INSERT");
    const res = await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: `entityfail-${++seq}` });
    expect(res.status).toBe(500);
    expect(await h.prisma.navNode.count()).toBe(nBefore);
    expect(await h.prisma.kbDocVersion.count()).toBe(vBefore);
  });
});
