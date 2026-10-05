// M5/S10 AC-M5-3 权限/调岗/继承中断/move 即时失效对抗 —— cloud/vec0 形态（真 HTTP 端到端）。
//
// 每条变更同一节奏：翻转前能搜到独有词 -> 真实变更通道（策略 PUT/继承 PATCH/move+retain/
// 调岗/角色授予/停用）提交成功 -> 不 reindex、不重启、不 sleep、同 search.db 立即再搜 -> 可见集已变。
// 客观信号：策略/继承写 bump policyVersion，变更后首搜响应 pv 必须等于新版本；move/调岗不 bump pv
// 但 scope 每查实时重算仍即变。无 reindex 证据：currentReindex 恒 null + chunks/fts/vec 行数与行指纹前后不变
// （派生库不清理 != 泄漏：旧 chunk 物理留存，召回侧实时 temp_scope/temp_field_grant 剔除）。
// 向量经 stub fetch（dim=4 确定性向量，零真外网）；每用例独立用户，避免可见集跨用例累积。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupAc3, type Ac3World } from "./m5-ac-m5-3-harness.js";

let w: Ac3World;
const MODES = ["auto", "fts", "vector"] as const;
type Mode = (typeof MODES)[number];

async function noReindex(): Promise<void> {
  const m = await import("../../../domain/search/reindex.js");
  expect(m.currentReindex(), "全程不得触发 reindex").toBeNull();
  expect(m.isReindexing()).toBe(false);
}

async function searchAs(user: string, word: string, mode: Mode) {
  const r = await w.search(user, word, mode);
  expect(r.status, `搜索应 200（mode=${mode}）`).toBe(200);
  return r.body as {
    items: Array<{ entityId: string; title: string; snippet: string; matchedField: string | null }>;
    policyVersion: number;
  };
}

/** 实体级消失：三 mode 目标实体缺席 + 整个序列化无独有词；返回末态 pv。 */
async function assertEntityGone(user: string, word: string, entityId: string): Promise<number> {
  let pv = 0;
  for (const mode of MODES) {
    const res = await searchAs(user, word, mode);
    expect(res.items.map((i) => i.entityId), `mode=${mode} 不得命中目标实体`).not.toContain(entityId);
    expect(JSON.stringify(res), `mode=${mode} 序列化零泄漏独有词`).not.toContain(word);
    pv = res.policyVersion;
  }
  return pv;
}

/** 实体级可见：三 mode 均命中且含独有词。 */
async function assertVisible(user: string, word: string, entityId: string): Promise<void> {
  for (const mode of MODES) {
    const res = await searchAs(user, word, mode);
    expect(res.items.map((i) => i.entityId), `mode=${mode} 应命中`).toContain(entityId);
    expect(JSON.stringify(res)).toContain(word);
  }
}

beforeAll(async () => { w = await setupAc3({ mode: "cloud", label: "cloud" }); }, 180000);
afterAll(async () => { await w.cleanup(); });

describe("AC-M5-3 cloud 收权/恢复：策略 PUT deletes 即时生效 + 派生库零改动", () => {
  it("allow 可见 -> 移除授予三 mode 零召回零泄漏 -> 重授恢复；chunk 物理留存指纹不变；pv 单调", async () => {
    const u = "ac3c_revoke";
    await w.mkUser(u);
    const r = await w.mkRecord("rev");
    const g1 = await w.putPolicies(r.nodeId, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"] }] });
    expect(g1.status).toBe(200);
    const pv1 = (await g1.json() as { policyVersion: number }).policyVersion;
    await assertVisible(u, r.secretWord, r.recordId);
    expect((await searchAs(u, r.secretWord, "fts")).policyVersion).toBe(pv1);
    const snap = w.snapshotSearch();
    expect(snap.vec, "cloud 确实写入向量行").toBeGreaterThan(0);

    const g2 = await w.putPolicies(r.nodeId, { deletes: [{ subjectType: "user", subjectId: u }] });
    expect(g2.status).toBe(200);
    const pv2 = (await g2.json() as { policyVersion: number }).policyVersion;
    expect(pv2).toBeGreaterThan(pv1);
    const pvGone = await assertEntityGone(u, r.secretWord, r.recordId);
    expect(pvGone).toBe(pv2); // 变更后第一次搜索读到的就是新版本

    const g3 = await w.putPolicies(r.nodeId, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"] }] });
    expect(g3.status).toBe(200);
    await assertVisible(u, r.secretWord, r.recordId); // 实时收敛，非一次性拉黑

    await noReindex();
    const after = w.snapshotSearch();
    expect(after.chunks).toBe(snap.chunks);
    expect(after.fts).toBe(snap.fts);
    expect(after.vec).toBe(snap.vec);
    expect(after.checksum).toBe(snap.checksum);
    expect(w.chunksForEntity("record", r.recordId)).toBeGreaterThan(0); // 旧 chunk 仍在库里
  }, 60000);
});

describe("AC-M5-3 cloud 中断/恢复继承：祖先 PATCH，子孙文档即时失访/恢复", () => {
  it("孙 doc 经 kb 授予可见；父 doc breakInheritance 后子孙立即不可见；恢复继承重新可见", async () => {
    const u = "ac3c_inherit";
    await w.mkUser(u);
    const parent = await w.mkDoc("inhp");
    const child = await w.mkDoc("inhc", { kbId: parent.kbId, parentDocId: parent.docId });
    const g = await w.putPolicies(parent.kbNodeId, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"] }] });
    expect(g.status).toBe(200);
    const pv1 = (await g.json() as { policyVersion: number }).policyVersion;
    await assertVisible(u, child.word, child.docId);
    const snap = w.snapshotSearch();

    const cut = await w.patchInheritance(parent.nodeId, false);
    expect(cut.status).toBe(200);
    const pv2 = (await cut.json() as { policyVersion: number }).policyVersion;
    expect(pv2).toBeGreaterThan(pv1);
    expect(await assertEntityGone(u, child.word, child.docId)).toBe(pv2);

    const restore = await w.patchInheritance(parent.nodeId, true);
    expect(restore.status).toBe(200);
    await assertVisible(u, child.word, child.docId);
    await noReindex();
    expect(w.snapshotSearch().checksum).toBe(snap.checksum);
  }, 60000);
});

describe("AC-M5-3 cloud move：移入空 group 断祖先继承即时失访；删组 retain 回位恢复", () => {
  it("kb 祖先授内容 r -> move doc 进组立即不可见（nodeId/resourceId 稳定）-> retain 回默认父恢复；pv 不变", async () => {
    const u = "ac3c_move";
    await w.mkUser(u);
    // doc + kb 祖先：kb 合法授内容 r；move doc 进空组断继承，retain 回 kb 默认父。
    const d = await w.mkDoc("mov");
    const g = await w.putPolicies(d.kbNodeId, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"] }] });
    expect(g.status).toBe(200);
    await assertVisible(u, d.word, d.docId);
    const pvBefore = (await searchAs(u, d.word, "fts")).policyVersion;
    const snap = w.snapshotSearch();

    const groupId = await w.createGroup("ac3-move-归档组");
    const moved = await w.moveNode(d.nodeId, groupId);
    expect(moved.status).toBe(200);
    // move 只 bump navVersion 不 bump policyVersion；scope 无跨请求缓存，可见集仍立即变化。
    expect(await assertEntityGone(u, d.word, d.docId)).toBe(pvBefore);
    const node = await w.prisma.navNode.findUniqueOrThrow({ where: { id: d.nodeId } });
    expect(node.resourceType).toBe("doc"); // nav 节点键域稳定，不制造 C 类悬空 chunk
    expect(node.resourceId).toBe(d.docId);
    expect(node.parentId).toBe(groupId);

    const retained = await w.deleteGroupRetain(groupId);
    expect(retained.status).toBe(200);
    await assertVisible(u, d.word, d.docId);
    await noReindex();
    expect(w.snapshotSearch().checksum).toBe(snap.checksum);
    expect(w.chunksForEntity("doc", d.docId)).toBeGreaterThan(0);
  }, 60000);
});

describe("AC-M5-3 cloud 调岗/角色变化：部门与自定义角色授予即时收窄/放开", () => {
  it("部门 r 授予：调入立即可见、调出立即不可见（不 bump pv）", async () => {
    const u = "ac3c_dept";
    await w.mkUser(u);
    const r = await w.mkRecord("dept");
    const dept = await w.createDept("ac3-三部");
    const g = await w.putPolicies(r.nodeId, { upserts: [{ subjectType: "dept", subjectId: dept, actions: ["r"] }] });
    expect(g.status).toBe(200);
    await assertEntityGone(u, r.secretWord, r.recordId);
    const snap = w.snapshotSearch();
    const pv0 = (await searchAs(u, r.secretWord, "fts")).policyVersion;

    const add = await w.assignDepartments(u, { add: [dept] });
    expect(add.status).toBe(200);
    await assertVisible(u, r.secretWord, r.recordId);
    const rm = await w.assignDepartments(u, { remove: [dept] });
    expect(rm.status).toBe(200);
    expect(await assertEntityGone(u, r.secretWord, r.recordId)).toBe(pv0); // 无策略写，pv 不变但可见集即变
    await noReindex();
    expect(w.snapshotSearch().checksum).toBe(snap.checksum);
  }, 60000);

  it("自定义角色 r 授予：授予 diff 加入立即可见、移除立即不可见", async () => {
    const u = "ac3c_role";
    await w.mkUser(u);
    const r = await w.mkRecord("role");
    const roleId = await w.createCustomRole("ac3-检索角色");
    const g = await w.putPolicies(r.nodeId, { upserts: [{ subjectType: "role", subjectId: roleId, actions: ["r"] }] });
    expect(g.status).toBe(200);
    await assertEntityGone(u, r.secretWord, r.recordId);

    const add = await w.replaceRoleGrants(roleId, [{ subjectType: "user", subjectId: u }]);
    expect(add.status).toBe(200);
    await assertVisible(u, r.secretWord, r.recordId);
    const rm = await w.replaceRoleGrants(roleId, []);
    expect(rm.status).toBe(200);
    await assertEntityGone(u, r.secretWord, r.recordId);
    await noReindex();
  }, 60000);
});

describe("AC-M5-3 cloud 用户停用：旧 token 下次请求即 401；激活强制重登", () => {
  it("停用 -> 401（不进 scope/召回）；激活后旧 tv 仍 401，当前 tv 新 token 200", async () => {
    const u = "ac3c_dis";
    await w.mkUser(u);
    const r = await w.mkRecord("dis");
    const g = await w.putPolicies(r.nodeId, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"] }] });
    expect(g.status).toBe(200);
    await assertVisible(u, r.secretWord, r.recordId);

    const dis = await w.disable(u);
    expect(dis.status).toBe(200);
    expect((await w.search(u, r.secretWord, "auto")).status).toBe(401); // 登录态即时失效

    const react = await w.reactivate(u);
    expect(react.status).toBe(200);
    expect((await w.search(u, r.secretWord, "auto")).status).toBe(401); // 旧 tv 仍不符，强制重登
    const tv = (await w.prisma.user.findUniqueOrThrow({ where: { id: u }, select: { tokenVersion: true } })).tokenVersion;
    const res = await w.app.request(`/api/v1/search?q=${encodeURIComponent(r.secretWord)}&mode=auto`,
      { headers: { Authorization: `Bearer ${await w.token(u, tv)}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ entityId: string }> };
    expect(body.items.map((i) => i.entityId)).toContain(r.recordId);
    await noReindex();
  }, 60000);
});

describe("AC-M5-3 cloud fieldMask 加/去：字段级召回与 matchedField 即时按新策略（节点仍可见）", () => {
  it("加白名单 mask：fts 密文零命中，auto/vector 实体即便经白名单 chunk 返回也零密文泄漏；去 mask 恢复", async () => {
    const u = "ac3c_mask";
    await w.mkUser(u);
    const r = await w.mkRecord("mask");
    const g = await w.putPolicies(r.nodeId, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"] }] });
    expect(g.status).toBe(200);
    await assertVisible(u, r.secretWord, r.recordId);
    const snap = w.snapshotSearch();

    const masked = await w.putPolicies(r.nodeId, { upserts: [{
      subjectType: "user", subjectId: u, actions: ["r"], fieldMask: { allowFields: [r.primaryField, r.pubField] },
    }] });
    expect(masked.status).toBe(200);

    // fts：密文词只存在于被 mask 字段 chunk，MATCH 经 allowed 收敛后实体必须缺席。
    const fts = await searchAs(u, r.secretWord, "fts");
    expect(fts.items.map((i) => i.entityId)).not.toContain(r.recordId);
    // auto/vector：KNN 可能经白名单 chunk 把实体带回，但整个响应绝不含密文/被 mask 字段名，
    // 且该实体命中项 matchedField 只能是白名单字段或 null（§4.7 规则 6）。
    for (const mode of ["auto", "vector"] as const) {
      const res = await searchAs(u, r.secretWord, mode);
      expect(JSON.stringify(res), `mode=${mode} 零密文`).not.toContain(r.secretWord);
      for (const it of res.items.filter((i) => i.entityId === r.recordId)) {
        expect(["公开字段", "主字段", null]).toContain(it.matchedField);
        expect(it.snippet).not.toContain(r.secretWord);
      }
    }
    // 白名单字段照常命中，matchedField 为白名单字段名，无被 mask 字段名/值。
    const pub = await searchAs(u, r.pubWord, "fts");
    const item = pub.items.find((i) => i.entityId === r.recordId);
    expect(item).toBeTruthy();
    expect(item!.matchedField).toBe("公开字段");
    expect(item!.snippet).toContain(r.pubWord);
    expect(JSON.stringify(item)).not.toContain("私密字段");

    const unmask = await w.putPolicies(r.nodeId, { upserts: [{ subjectType: "user", subjectId: u, actions: ["r"], fieldMask: null }] });
    expect(unmask.status).toBe(200);
    await assertVisible(u, r.secretWord, r.recordId);
    await noReindex();
    expect(w.snapshotSearch().checksum).toBe(snap.checksum);
  }, 60000);
});
