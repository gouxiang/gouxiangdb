// M3/S3 路由层写点同步测试（kb.ts 文档生命周期：#13b 改名/PUT content、#13c 移动、
// #13d 软删/恢复/永久删）。容器 #11/#12 与建文档 #13a 见 nav-sync-kb.test.ts。
//
// 每操作：正向 reconcile 0 阻断 + 方向① nav 失败实体回滚 + 方向② 实体失败 nav 未变。
// 另含 PUT content 乐观锁 VERSION_CONFLICT 旧契约回归（冲突时事务回滚、节点名不变）。

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
  h = await makeNavHarness("gx-m3-s3-kbdocs-");
  await h.createUser(OWNER, { email: "owner@kbd.com", displayName: "Owner" });
  // 权限核心模型（二）：库放行只看「角色 × 库」，脚手架 owner 挂超级管理员才动得了库。
  await h.grantRole(OWNER);
});
afterAll(async () => h.cleanup());
afterEach(async () => stopFailing(h));

const post = async (url: string, body: unknown) =>
  h.app.request(url, { method: "POST", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const patch = async (url: string, body: unknown) =>
  h.app.request(url, { method: "PATCH", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const put = async (url: string, body: unknown) =>
  h.app.request(url, { method: "PUT", headers: { ...(await h.auth(OWNER)), "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = async (url: string) =>
  h.app.request(url, { method: "DELETE", headers: await h.auth(OWNER) });

let seq = 0;
async function freshKbDoc(name?: string) {
  const kbRes = await post("/api/kb", { name: name ?? `KD${++seq}` });
  const kb = (await json<{ knowledgeBase: { id: string } }>(kbRes)).knowledgeBase;
  const docRes = await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "d" });
  const doc = (await json<{ doc: { id: string } }>(docRes)).doc;
  return { kb, doc };
}

describe("#13b 文档改名 / PUT content 附带 title", () => {
  it("正向：PATCH 与 PUT content 都同步节点 name，0 阻断", async () => {
    const { doc } = await freshKbDoc(`KD13b-${++seq}`);
    expect((await patch(`/api/kb/docs/${doc.id}`, { title: "patched" })).status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", doc.id) } })).name).toBe("patched");
    expect((await put(`/api/kb/docs/${doc.id}/content`, { content: "# body", title: "via-put" })).status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", doc.id) } })).name).toBe("via-put");
    await assertNoBlockingDiffs(h);
  });

  it("方向①：nav 失败 -> 500，PATCH 标题不落库", async () => {
    const { doc } = await freshKbDoc(`KD13b-r1-${++seq}`);
    await failNavWrites(h);
    const res = await patch(`/api/kb/docs/${doc.id}`, { title: "不该落" });
    expect(res.status).toBe(500);
    expect((await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: doc.id } })).title).toBe("d");
  });

  it("方向②：kb_docs UPDATE 失败 -> 500，节点 name 未变", async () => {
    const { doc } = await freshKbDoc(`KD13b-r2-${++seq}`);
    await failEntityWrite(h, "kb_docs", "UPDATE");
    const res = await patch(`/api/kb/docs/${doc.id}`, { title: "实体失败" });
    expect(res.status).toBe(500);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", doc.id) } })).name).toBe("d");
  });

  it("乐观锁版本不匹配 -> 409 VERSION_CONFLICT 旧信封，内容与节点名都不改（事务回滚）", async () => {
    const { doc } = await freshKbDoc(`KD13b-vc-${++seq}`);
    const res = await put(`/api/kb/docs/${doc.id}/content`, { content: "x", title: "冲突名", baseVersion: 999 });
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string; currentVersion: number | null };
    expect(body.code).toBe("VERSION_CONFLICT");
    expect(body.currentVersion).toBe(0);
    const row = await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: doc.id } });
    expect(row.title).toBe("d");
    expect(row.contentVersion).toBe(0);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", doc.id) } })).name).toBe("d");
  });
});

describe("#13c doc 移动（子树 path 重写）", () => {
  it("正向：父 doc 移到根，自身与后代改挂并重算子树 path，0 阻断", async () => {
    const { kb } = await freshKbDoc(`KD13c-${++seq}`);
    const root = (await json<{ doc: { id: string } }>(await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "r" }))).doc;
    const mid = (await json<{ doc: { id: string } }>(await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "m", parentId: root.id }))).doc;
    const leaf = (await json<{ doc: { id: string } }>(await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "l", parentId: mid.id }))).doc;
    expect((await post(`/api/kb/docs/${root.id}/move`, { parentId: null })).status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", root.id) } })).parentId)
      .toBe(nodeId("kb", kb.id));
    const ln = await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", leaf.id) } });
    expect(ln.path).toBe(`/nav_kb_${kb.id}/nav_doc_${root.id}/nav_doc_${mid.id}/nav_doc_${leaf.id}/`);
    expect(ln.depth).toBe(4);
    await assertNoBlockingDiffs(h);
  });

  it("方向①：nav 失败 -> 500，实体 parentId 不变", async () => {
    const { kb } = await freshKbDoc(`KD13c-r1-${++seq}`);
    const root = (await json<{ doc: { id: string } }>(await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "r" }))).doc;
    const child = (await json<{ doc: { id: string } }>(await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "c", parentId: root.id }))).doc;
    await failNavWrites(h);
    const res = await post(`/api/kb/docs/${child.id}/move`, { parentId: null });
    expect(res.status).toBe(500);
    expect((await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: child.id } })).parentId).toBe(root.id);
  });

  it("方向②：kb_docs UPDATE 失败 -> 500，实体与节点 parentId 都不变", async () => {
    const { kb } = await freshKbDoc(`KD13c-r2-${++seq}`);
    const root = (await json<{ doc: { id: string } }>(await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "r" }))).doc;
    const child = (await json<{ doc: { id: string } }>(await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "c", parentId: root.id }))).doc;
    await failEntityWrite(h, "kb_docs", "UPDATE");
    const res = await post(`/api/kb/docs/${child.id}/move`, { parentId: null });
    expect(res.status).toBe(500);
    expect((await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: child.id } })).parentId).toBe(root.id);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", child.id) } })).parentId)
      .toBe(nodeId("doc", root.id));
  });
});

describe("#13d 软删 / 恢复 / 永久删", () => {
  it("正向：软删节点置 deletedAt，恢复复活，0 阻断", async () => {
    const { doc } = await freshKbDoc(`KD13d-${++seq}`);
    expect((await del(`/api/kb/docs/${doc.id}`)).status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", doc.id) } })).deletedAt).not.toBeNull();
    expect((await post(`/api/kb/docs/${doc.id}/restore`, {})).status).toBe(200);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", doc.id) } })).deletedAt).toBeNull();
    expect((await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: doc.id } })).deletedAt).toBeNull();
    await assertNoBlockingDiffs(h);
  });

  it("方向①：nav 失败 -> 500，软删实体不落库", async () => {
    const { doc } = await freshKbDoc(`KD13d-r1-${++seq}`);
    await failNavWrites(h);
    const res = await del(`/api/kb/docs/${doc.id}`);
    expect(res.status).toBe(500);
    expect((await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: doc.id } })).deletedAt).toBeNull();
  });

  it("方向②：kb_docs UPDATE 失败 -> 500，节点未软删", async () => {
    const { doc } = await freshKbDoc(`KD13d-r2-${++seq}`);
    await failEntityWrite(h, "kb_docs", "UPDATE");
    const res = await del(`/api/kb/docs/${doc.id}`);
    expect(res.status).toBe(500);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", doc.id) } })).deletedAt).toBeNull();
  });

  it("恢复方向①：nav 失败 -> 500，实体仍软删", async () => {
    const { doc } = await freshKbDoc(`KD13d-rs-${++seq}`);
    await del(`/api/kb/docs/${doc.id}`);
    await failNavWrites(h);
    const res = await post(`/api/kb/docs/${doc.id}/restore`, {});
    expect(res.status).toBe(500);
    expect((await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: doc.id } })).deletedAt).not.toBeNull();
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", doc.id) } })).deletedAt).not.toBeNull();
  });

  it("永久删正向：清自身 shortcut + 删节点；孤儿子文档节点改挂 kb，0 阻断", async () => {
    const { kb } = await freshKbDoc(`KD13d-pg-${++seq}`);
    const parent = (await json<{ doc: { id: string } }>(await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "p" }))).doc;
    const child = (await json<{ doc: { id: string } }>(await post(`/api/kb/${kb.id}/docs`, { kind: "doc", title: "c", parentId: parent.id }))).doc;
    const res = await del(`/api/kb/docs/${parent.id}/permanent`);
    expect(res.status).toBe(200);
    expect(await h.prisma.kbDoc.count({ where: { id: parent.id } })).toBe(0);
    expect(await h.prisma.navNode.count({ where: { id: nodeId("doc", parent.id) } })).toBe(0);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nodeId("doc", child.id) } })).parentId)
      .toBe(nodeId("kb", kb.id));
    await assertNoBlockingDiffs(h);
  });

  it("永久删方向②（强证）：nav 已清后 kb_docs DELETE 失败 -> 实体仍在、节点随事务复活", async () => {
    const { doc } = await freshKbDoc(`KD13d-pg-r2-${++seq}`);
    const nid = nodeId("doc", doc.id);
    await failEntityWrite(h, "kb_docs", "DELETE");
    const res = await del(`/api/kb/docs/${doc.id}/permanent`);
    expect(res.status).toBe(500);
    expect(await h.prisma.kbDoc.count({ where: { id: doc.id } })).toBe(1);
    expect(await h.prisma.navNode.count({ where: { id: nid } })).toBe(1);
    expect((await h.prisma.navNode.findUniqueOrThrow({ where: { id: nid } })).deletedAt).toBeNull();
    await assertNoBlockingDiffs(h);
  });
});
