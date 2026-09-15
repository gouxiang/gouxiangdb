// M4/S5 旧三表 <-> auth_policies 同事务投影双写：行数对账 + 双向故障注入原子性。
//
// 11 写点经旧 HTTP 入口真打（真 createApp/真迁移/真 JWT），逐源对账确定性策略行：
//   base 加/改/移除成员、kb 加/移除成员、单文档 ACL 授予/撤销。
// 双向故障注入（普通 CREATE TRIGGER，非 TEMP——见 navRouteHarness 注释）：
//   方向① auth_policies INSERT ABORT -> 旧表写整体回滚（无 members 半截行）；
//   方向② 旧表（members / kb_doc_acls）INSERT ABORT -> auth_policies 不落地（无策略半截行）。

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  makeNavHarness,
  failEntityWrite,
  dropAllFailTriggers,
  seedBaseWithStarter,
  seedKbWithDocs,
  type CharHarness,
} from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import {
  resourceActionsForLegacyRole,
  toActionString,
} from "@gx/shared-types";

let h: CharHarness;
let baseId = "";
let kbId = "";
let rootDoc = "";

async function authHeaders(user: string): Promise<Record<string, string>> {
  return { "Content-Type": "application/json", ...(await h.auth(user)) };
}

beforeAll(async () => {
  h = await makeNavHarness("gx-s5-dual-");
  await h.createUser("owner");
  await h.createUser("bm1", { email: "bm1@example.com" });
  await h.createUser("bm2", { email: "bm2@example.com" });
  await h.createUser("km1", { email: "km1@example.com" });
  await h.createUser("dm1", { email: "dm1@example.com" });
  const b = await seedBaseWithStarter(h, "s5d");
  baseId = b.baseId;
  const k = await seedKbWithDocs(h, "s5d");
  kbId = k.kbId;
  rootDoc = k.rootDoc;
}, 120000);

afterEach(async () => {
  await dropAllFailTriggers(h).catch(() => undefined);
});

afterAll(async () => {
  await h.cleanup();
});

async function legacyPolicy(id: string) {
  return await h.prisma.authPolicy.findUnique({ where: { id } });
}

describe("base 成员三写点投影对账（members -> nav_base_*）", () => {
  it("加成员 editor：members 行 + legacy:member 策略行同生，动作串=base editor 档", async () => {
    const res = await h.app.request(`/api/bases/${baseId}/members`, {
      method: "POST",
      headers: await authHeaders("owner"),
      body: JSON.stringify({ email: "bm1@example.com", role: "editor" }),
    });
    expect(res.status).toBe(201);
    const member = await h.prisma.member.findUniqueOrThrow({
      where: { baseId_userId: { baseId, userId: "bm1" } },
    });
    const pol = await legacyPolicy(`pol_legacy_member_${member.id}`);
    expect(pol).not.toBeNull();
    expect(pol!.nodeId).toBe(nodeId("base", baseId));
    expect(pol!.subjectType).toBe("user");
    expect(pol!.subjectId).toBe("bm1");
    expect(pol!.reason).toBe("legacy:member");
    expect(pol!.actions).toBe(toActionString(resourceActionsForLegacyRole("base", "editor")));
  });

  it("改角色 editor->viewer：投影精确收窄（非并集，无 c/u/d 残留）", async () => {
    const member = await h.prisma.member.findUniqueOrThrow({
      where: { baseId_userId: { baseId, userId: "bm1" } },
    });
    const res = await h.app.request(`/api/bases/${baseId}/members/${member.id}`, {
      method: "PATCH",
      headers: await authHeaders("owner"),
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(res.status).toBe(200);
    const pol = await legacyPolicy(`pol_legacy_member_${member.id}`);
    expect(pol!.actions).toBe(toActionString(resourceActionsForLegacyRole("base", "viewer")));
    expect(pol!.actions).toBe("r");
  });

  it("移除成员：members 行与 legacy:member 策略行同灭", async () => {
    const member = await h.prisma.member.findUniqueOrThrow({
      where: { baseId_userId: { baseId, userId: "bm1" } },
    });
    const res = await h.app.request(`/api/bases/${baseId}/members/${member.id}`, {
      method: "DELETE",
      headers: await authHeaders("owner"),
    });
    expect(res.status).toBe(200);
    expect(await h.prisma.member.findUnique({ where: { id: member.id } })).toBeNull();
    expect(await legacyPolicy(`pol_legacy_member_${member.id}`)).toBeNull();
  });
});

describe("kb 成员双写点投影对账（kb_members -> nav_kb_*）", () => {
  it("加成员 commenter：kb_members + legacy:kb_member 同生", async () => {
    const res = await h.app.request(`/api/kb/${kbId}/members`, {
      method: "POST",
      headers: await authHeaders("owner"),
      body: JSON.stringify({ email: "km1@example.com", role: "commenter" }),
    });
    expect(res.status).toBe(201);
    const m = await h.prisma.kbMember.findUniqueOrThrow({
      where: { kbId_userId: { kbId, userId: "km1" } },
    });
    const pol = await legacyPolicy(`pol_legacy_kbmember_${m.id}`);
    expect(pol).not.toBeNull();
    expect(pol!.nodeId).toBe(nodeId("kb", kbId));
    expect(pol!.reason).toBe("legacy:kb_member");
    expect(pol!.actions).toBe(toActionString(resourceActionsForLegacyRole("kb", "commenter")));
  });

  it("移除成员：kb_members 与 legacy:kb_member 同灭", async () => {
    const m = await h.prisma.kbMember.findUniqueOrThrow({
      where: { kbId_userId: { kbId, userId: "km1" } },
    });
    const res = await h.app.request(`/api/kb/${kbId}/members/km1`, {
      method: "DELETE",
      headers: await authHeaders("owner"),
    });
    expect(res.status).toBe(200);
    expect(await h.prisma.kbMember.findUnique({ where: { id: m.id } })).toBeNull();
    expect(await legacyPolicy(`pol_legacy_kbmember_${m.id}`)).toBeNull();
  });
});

describe("单文档 ACL 双写点投影对账（kb_doc_acls -> nav_doc_*）", () => {
  it("授予 editor：acl 行 + legacy:acl 策略行同生（resourceType 取 kb_docs.kind=doc）", async () => {
    const res = await h.app.request(`/api/kb/docs/${rootDoc}/acl`, {
      method: "PUT",
      headers: await authHeaders("owner"),
      body: JSON.stringify({ email: "dm1@example.com", role: "editor" }),
    });
    expect(res.status).toBe(200);
    const acl = await h.prisma.kbDocAcl.findUniqueOrThrow({
      where: { docId_userId: { docId: rootDoc, userId: "dm1" } },
    });
    const pol = await legacyPolicy(`pol_legacy_acl_${acl.id}`);
    expect(pol).not.toBeNull();
    expect(pol!.nodeId).toBe(nodeId("doc", rootDoc));
    expect(pol!.reason).toBe("legacy:acl");
    expect(pol!.actions).toBe(toActionString(resourceActionsForLegacyRole("doc", "editor")));
  });

  it("撤销（role=null）：acl 行与 legacy:acl 策略行同灭", async () => {
    const acl = await h.prisma.kbDocAcl.findUniqueOrThrow({
      where: { docId_userId: { docId: rootDoc, userId: "dm1" } },
    });
    const res = await h.app.request(`/api/kb/docs/${rootDoc}/acl`, {
      method: "PUT",
      headers: await authHeaders("owner"),
      body: JSON.stringify({ email: "dm1@example.com", role: null }),
    });
    expect(res.status).toBe(200);
    expect(await h.prisma.kbDocAcl.findUnique({ where: { id: acl.id } })).toBeNull();
    expect(await legacyPolicy(`pol_legacy_acl_${acl.id}`)).toBeNull();
  });
});

describe("双向故障注入：同事务原子性（普通 trigger）", () => {
  it("方向① auth_policies 写失败 -> base 加成员整体回滚，members 无半截行", async () => {
    await failEntityWrite(h, "auth_policies", "INSERT");
    const res = await h.app.request(`/api/bases/${baseId}/members`, {
      method: "POST",
      headers: await authHeaders("owner"),
      body: JSON.stringify({ email: "bm2@example.com", role: "viewer" }),
    });
    expect(res.status).toBe(500);
    await dropAllFailTriggers(h);
    // 旧表无残留（事务整体回滚）。
    expect(await h.prisma.member.findUnique({
      where: { baseId_userId: { baseId, userId: "bm2" } },
    })).toBeNull();
    // 该用户在该节点也无任何策略行。
    const stray = await h.prisma.authPolicy.findFirst({
      where: { nodeId: nodeId("base", baseId), subjectId: "bm2" },
    });
    expect(stray).toBeNull();
  });

  it("方向② members 写失败 -> 无 auth_policies 落地（投影不悬空）", async () => {
    await failEntityWrite(h, "members", "INSERT");
    const res = await h.app.request(`/api/bases/${baseId}/members`, {
      method: "POST",
      headers: await authHeaders("owner"),
      body: JSON.stringify({ email: "bm2@example.com", role: "viewer" }),
    });
    expect(res.status).toBe(500);
    await dropAllFailTriggers(h);
    const stray = await h.prisma.authPolicy.findFirst({
      where: { nodeId: nodeId("base", baseId), subjectId: "bm2" },
    });
    expect(stray).toBeNull();
  });

  it("方向② kb_doc_acls 写失败 -> 无 legacy:acl 策略落地", async () => {
    await failEntityWrite(h, "kb_doc_acls", "INSERT");
    const res = await h.app.request(`/api/kb/docs/${rootDoc}/acl`, {
      method: "PUT",
      headers: await authHeaders("owner"),
      body: JSON.stringify({ email: "dm1@example.com", role: "viewer" }),
    });
    expect(res.status).toBe(500);
    await dropAllFailTriggers(h);
    const stray = await h.prisma.authPolicy.findFirst({
      where: { nodeId: nodeId("doc", rootDoc), subjectId: "dm1", reason: "legacy:acl" },
    });
    expect(stray).toBeNull();
  });

  it("触发器清除后恢复：同一加成员操作成功且双写齐全（证明仅注入致败，非代码缺陷）", async () => {
    const res = await h.app.request(`/api/bases/${baseId}/members`, {
      method: "POST",
      headers: await authHeaders("owner"),
      body: JSON.stringify({ email: "bm2@example.com", role: "viewer" }),
    });
    expect(res.status).toBe(201);
    const member = await h.prisma.member.findUniqueOrThrow({
      where: { baseId_userId: { baseId, userId: "bm2" } },
    });
    expect(await legacyPolicy(`pol_legacy_member_${member.id}`)).not.toBeNull();
  });
});
