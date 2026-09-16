// M5/S10 AC-M5-3 即时失效对抗 —— off/fts-only 形态关键路径（真 HTTP 端到端，无 vec_chunks）。
//
// 覆盖派工"off 与 cloud 两态各至少一条关键路径"：收权/恢复、继承中断/恢复、move、调岗、停用 401。
// 无 embedding 配置 -> 不走向量；mode=vector 强制时按 §4.9 静默回退关键词（200，不报错不放宽权限），
// 故三 mode 断言口径与 cloud 一致：实体消失/恢复只取决于实时 scope，与检索路无关。
// 无 reindex 证据：currentReindex 恒 null + search.db chunks/fts 行数与行指纹前后不变（off 形态 vec=null）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAc3, type Ac3World } from "./m5-ac-m5-3-harness.js";

let w: Ac3World;
const MODES = ["auto", "fts", "vector"] as const;
type Mode = (typeof MODES)[number];

async function noReindex(): Promise<void> {
  const m = await import("../../../domain/search/reindex.js");
  expect(m.currentReindex()).toBeNull();
  expect(m.isReindexing()).toBe(false);
}

async function searchAs(user: string, word: string, mode: Mode) {
  const r = await w.search(user, word, mode);
  expect(r.status, `mode=${mode} 应 200`).toBe(200);
  return r.body as {
    items: Array<{ entityId: string; title: string; snippet: string; matchedField: string | null }>;
    policyVersion: number;
    mode: string;
  };
}

async function assertGone(user: string, word: string, entityId: string): Promise<number> {
  let pv = 0;
  for (const mode of MODES) {
    const res = await searchAs(user, word, mode);
    expect(res.items.map((i) => i.entityId), `mode=${mode} 不得命中`).not.toContain(entityId);
    expect(JSON.stringify(res)).not.toContain(word);
    pv = res.policyVersion;
  }
  return pv;
}

async function assertVisible(user: string, word: string, entityId: string): Promise<void> {
  for (const mode of MODES) {
    const res = await searchAs(user, word, mode);
    expect(res.items.map((i) => i.entityId), `mode=${mode} 应命中（vector 强制应回退关键词）`).toContain(entityId);
  }
}

beforeAll(async () => { w = await setupAc3({ mode: "off", label: "off" }); }, 180000);
afterAll(async () => { await w.cleanup(); });

describe("AC-M5-3 off 收权/恢复 + policyVersion + 派生物零改动", () => {
  it("allow 可见 -> deletes 三 mode 零召回 -> 重授恢复；checksum 不变；强制 vector 回 fts", async () => {
    const u = "ac3o_revoke";
    await w.mkUser(u);
    const r = await w.mkRecord("orev");
    const g1 = await w.putPolicies(r.nodeId, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"] }] });
    expect(g1.status).toBe(200);
    const pv1 = (await g1.json() as { policyVersion: number }).policyVersion;
    await assertVisible(u, r.secretWord, r.recordId);
    const forcedVec = await searchAs(u, r.secretWord, "vector");
    expect(forcedVec.mode).toBe("fts"); // 无 vec0：强制 vector 静默回退关键词，非报错
    const snap = w.snapshotSearch();
    expect(snap.vec).toBeNull();

    const g2 = await w.putPolicies(r.nodeId, { deletes: [{ subjectType: "user", subjectId: u }] });
    expect(g2.status).toBe(200);
    const pv2 = (await g2.json() as { policyVersion: number }).policyVersion;
    expect(pv2).toBeGreaterThan(pv1);
    expect(await assertGone(u, r.secretWord, r.recordId)).toBe(pv2);

    const g3 = await w.putPolicies(r.nodeId, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"] }] });
    expect(g3.status).toBe(200);
    await assertVisible(u, r.secretWord, r.recordId);
    await noReindex();
    const after = w.snapshotSearch();
    expect(after.chunks).toBe(snap.chunks);
    expect(after.fts).toBe(snap.fts);
    expect(after.checksum).toBe(snap.checksum);
  }, 60000);
});

describe("AC-M5-3 off 继承中断/恢复（文档）", () => {
  it("孙 doc 经 kb 授予可见 -> 父 doc 断继承立即不可见 -> 恢复", async () => {
    const u = "ac3o_inh";
    await w.mkUser(u);
    const parent = await w.mkDoc("oinhp");
    const child = await w.mkDoc("oinhc", { kbId: parent.kbId, parentDocId: parent.docId });
    const g = await w.putPolicies(parent.kbNodeId, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"] }] });
    expect(g.status).toBe(200);
    await assertVisible(u, child.word, child.docId);
    const snap = w.snapshotSearch();

    const cut = await w.patchInheritance(parent.nodeId, false);
    expect(cut.status).toBe(200);
    await assertGone(u, child.word, child.docId);
    const restore = await w.patchInheritance(parent.nodeId, true);
    expect(restore.status).toBe(200);
    await assertVisible(u, child.word, child.docId);
    await noReindex();
    expect(w.snapshotSearch().checksum).toBe(snap.checksum);
  }, 60000);
});

describe("AC-M5-3 off move 与调岗", () => {
  it("move 进空 group 断祖先继承立即失访；retain 回位恢复", async () => {
    const u = "ac3o_move";
    await w.mkUser(u);
    const r = await w.mkRecord("omov");
    const g = await w.putPolicies(`nav_base_${r.baseId}`, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"] }] });
    expect(g.status).toBe(200);
    await assertVisible(u, r.secretWord, r.recordId);
    const snap = w.snapshotSearch();

    const groupId = await w.createGroup("ac3-off-move-组");
    const moved = await w.moveNode(r.nodeId, groupId);
    expect(moved.status).toBe(200);
    await assertGone(u, r.secretWord, r.recordId);
    const retained = await w.deleteGroupRetain(groupId);
    expect(retained.status).toBe(200);
    await assertVisible(u, r.secretWord, r.recordId);
    await noReindex();
    expect(w.snapshotSearch().checksum).toBe(snap.checksum);
  }, 60000);

  it("部门授予：调入立即可见、调出立即不可见（不 bump pv）", async () => {
    const u = "ac3o_dept";
    await w.mkUser(u);
    const r = await w.mkRecord("odept");
    const dept = await w.createDept("ac3-off-部门");
    const g = await w.putPolicies(r.nodeId, { upserts: [{ subjectType: "dept", subjectId: dept, actions: ["r"] }] });
    expect(g.status).toBe(200);
    await assertGone(u, r.secretWord, r.recordId);
    const pv0 = (await searchAs(u, r.secretWord, "fts")).policyVersion;
    const snap = w.snapshotSearch();

    const add = await w.assignDepartments(u, { add: [dept] });
    expect(add.status).toBe(200);
    await assertVisible(u, r.secretWord, r.recordId);
    const rm = await w.assignDepartments(u, { remove: [dept] });
    expect(rm.status).toBe(200);
    expect(await assertGone(u, r.secretWord, r.recordId)).toBe(pv0);
    await noReindex();
    expect(w.snapshotSearch().checksum).toBe(snap.checksum);
  }, 60000);
});

describe("AC-M5-3 off 用户停用即 401", () => {
  it("停用后旧 token 下次请求 401，不进 scope/召回", async () => {
    const u = "ac3o_dis";
    await w.mkUser(u);
    const r = await w.mkRecord("odis");
    const g = await w.putPolicies(r.nodeId, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"] }] });
    expect(g.status).toBe(200);
    await assertVisible(u, r.secretWord, r.recordId);
    const dis = await w.disable(u);
    expect(dis.status).toBe(200);
    expect((await w.search(u, r.secretWord, "auto")).status).toBe(401);
    await noReindex();
    // 物理留存：实体 chunk 未因停用被清理。
    expect(w.chunksForEntity("record", r.recordId)).toBeGreaterThan(0);
  }, 60000);
});
