// M4/S3.1 kb 处理器"授权提级"shadow 对拍（七守卫之外的 5 处 owner/editor 二次角色闸）：
//   kb.rename / kb.delete / kb.member.add / kb.member.remove -> kb 节点 manage_share（owner 独占）；
//   kb.doc.create -> kb 节点 c（editor 及以上）。
// 旧提级判断布尔为准，引擎同上下文对拍只观测；401 未登录/404 资源缺失不对拍；
// "不能踢 owner/自己"防反踢是业务保护不是授权动作，不在本补丁对拍。
// 真迁移临时库 + 真 createApp/真 JWT/真守卫；每用例 reset driftRegistry，afterEach 还原 env。
// deny 路径在写库前抛 403 不产生副作用；DELETE owner 用独立库（真软删），其余共享一个库。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KB_CONTENT_KEY } from "@gx/shared-types";
import { setupCharHarness, json, type CharHarness } from "../../nav/__tests__/characterization/charHarness.js";
import { driftRegistry } from "../shadow.js";
import { applyAuthzReconcileFixes } from "../reconcile.js";

let h: CharHarness;

async function call(method: string, url: string, userId: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = await h.auth(userId);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** 建独立活知识库（owner 自动成员）+ 可选额外成员，并 reconcile 投影到 auth_policies。 */
async function makeKb(owner: string, extra: Array<[string, string]> = []): Promise<string> {
  const res = await call("POST", "/api/kb", owner, { name: `kb-${owner}-${Math.random().toString(36).slice(2, 7)}` });
  const kbId = (await json<{ knowledgeBase: { id: string } }>(res)).knowledgeBase.id;
  for (const [u, role] of extra) {
    await h.prisma.kbMember.create({ data: { kbId, userId: u, role } });
  }
  // 权限核心模型（二）：进知识库的门只看「角色 × 库」。kb_members 行照旧保留（引擎对拍输入），
  // 但放行由下面这两条角色视野决定；editor 那份把 content 勾到 c，才有"建内容"的资格。
  await h.prisma.roleLibraryScope.createMany({
    data: [
      { roleId: "ke_role_view", libraryKind: "kb", libraryId: kbId, canManage: 0, visible: 1 },
      { roleId: "ke_role_edit", libraryKind: "kb", libraryId: kbId, canManage: 0, visible: 1,
        config: JSON.stringify({ tables: { [KB_CONTENT_KEY]: { read: true, create: true, update: true, delete: false } }, fields: {} }) },
    ],
  });
  await applyAuthzReconcileFixes(h.prisma);
  return kbId;
}

async function kbNodeId(kbId: string): Promise<string> {
  return (await h.prisma.navNode.findUniqueOrThrow({
    where: { workspaceId_resourceType_resourceId: { workspaceId: "ws_default", resourceType: "kb", resourceId: kbId } },
    select: { id: true },
  })).id;
}

/** 本用例 drift 快照断言：无任何类漂移/错误（requireKb r + 提级动作两路都须一致）。 */
function expectNoDrift(): void {
  const s = driftRegistry.snapshot();
  expect(s.overDeny).toBe(0);
  expect(s.overAllow).toBe(0);
  expect(s.errors).toBe(0);
  expect(s.unresolvedNode).toBe(0);
}

beforeAll(async () => {
  delete process.env.GX_AUTHZ_ENGINE;
  h = await setupCharHarness("gx-m4-s31-kb-");
  for (const u of ["ke_owner", "ke_editor", "ke_viewer", "ke_none", "ke_target"]) await h.createUser(u);
  // 建知识库是硬规则 B（只有超级管理员/管理员），故 owner 必须挂超级管理员。
  await h.grantRole("ke_owner");
  await h.prisma.role.create({ data: { id: "ke_role_view", workspaceId: "ws_default", name: "ke 只读", isSystem: 0, permissions: "[]" } });
  await h.prisma.role.create({ data: { id: "ke_role_edit", workspaceId: "ws_default", name: "ke 建内容", isSystem: 0, permissions: "[]" } });
  for (const [u, roleId] of [["ke_viewer", "ke_role_view"], ["ke_editor", "ke_role_edit"]] as const) {
    await h.prisma.roleAssignment.create({
      data: { roleId, subjectType: "user", subjectId: u, scopeType: "workspace", createdBy: "seed" },
    });
  }
}, 120000);

afterAll(async () => {
  delete process.env.GX_AUTHZ_ENGINE;
  await h.cleanup();
});

beforeEach(() => {
  process.env.GX_AUTHZ_ENGINE = "shadow";
  driftRegistry.reset();
});

afterEach(() => {
  delete process.env.GX_AUTHZ_ENGINE;
});

describe("shadow：kb 四处 owner-only 提级（manage_share）+ 建内容（c），old 与引擎一致", () => {
  let shared: string;

  beforeAll(async () => {
    shared = await makeKb("ke_owner", [["ke_editor", "editor"], ["ke_viewer", "viewer"]]);
  });

  it("kb.rename PATCH /:kbId：owner 200，editor/viewer 403，非成员 403(requireKb)，全 0 drift", async () => {
    expect((await call("PATCH", `/api/kb/${shared}`, "ke_owner", { name: "改名" })).status).toBe(200);
    expect((await call("PATCH", `/api/kb/${shared}`, "ke_editor", { name: "x" })).status).toBe(403);
    expect((await call("PATCH", `/api/kb/${shared}`, "ke_viewer", { name: "x" })).status).toBe(403);
    expect((await call("PATCH", `/api/kb/${shared}`, "ke_none", { name: "x" })).status).toBe(403);
    expectNoDrift();
    const renameChecks = driftRegistry.snapshot().recent.filter((e) => e.guard === "kb.rename");
    expect(renameChecks).toHaveLength(0); // 全一致不入漂移环；compared 已累加
    expect(driftRegistry.snapshot().compared).toBeGreaterThan(0);
  });

  // 「逐库逐人授权」已取消：知识库成员不再是授权维度（权限跟角色走），故增删端点整体下线，
  // 只留只读的 GET /:kbId/members 供"谁有权限进来"台账查看。这里锁死"入口已摘除"，
  // 防止将来又长出一条"配了不生效"的写通道。
  it("kb 成员增删端点已下线：POST/DELETE /:kbId/members -> 404（只读 GET 仍在）", async () => {
    expect((await call("POST", `/api/kb/${shared}/members`, "ke_owner", { email: "ke_target@example.com", role: "viewer" })).status).toBe(404);
    expect((await call("DELETE", `/api/kb/${shared}/members/ke_viewer`, "ke_owner")).status).toBe(404);
    expect((await call("GET", `/api/kb/${shared}/members`, "ke_owner")).status).toBe(200);
  });

  it("kb.doc.create POST /:kbId/docs：owner/editor 201（c allow），viewer/非成员 403（c deny / requireKb），全 0 drift", async () => {
    expect((await call("POST", `/api/kb/${shared}/docs`, "ke_owner", { kind: "doc", title: "o" })).status).toBe(201);
    expect((await call("POST", `/api/kb/${shared}/docs`, "ke_editor", { kind: "doc", title: "e" })).status).toBe(201);
    expect((await call("POST", `/api/kb/${shared}/docs`, "ke_viewer", { kind: "doc", title: "v" })).status).toBe(403);
    expect((await call("POST", `/api/kb/${shared}/docs`, "ke_none", { kind: "doc", title: "n" })).status).toBe(403);
    expectNoDrift();
  });

  it("kb.delete DELETE /:kbId：editor/viewer/非成员对共享库 403（manage_share deny，不删库），全 0 drift", async () => {
    expect((await call("DELETE", `/api/kb/${shared}`, "ke_editor")).status).toBe(403);
    expect((await call("DELETE", `/api/kb/${shared}`, "ke_viewer")).status).toBe(403);
    expect((await call("DELETE", `/api/kb/${shared}`, "ke_none")).status).toBe(403);
    expectNoDrift();
    // 共享库仍活着（deny 在软删前抛出）。
    const still = await h.prisma.knowledgeBase.findUnique({ where: { id: shared }, select: { deletedAt: true } });
    expect(still?.deletedAt).toBeNull();
  });

  it("kb.delete owner 用独立库：授权 allow 与引擎一致后 200 真软删，0 drift", async () => {
    const disposable = await makeKb("ke_owner");
    driftRegistry.reset(); // makeKb 内 reconcile 不产生对拍，但建库 HTTP 请求会；重置只看本次 DELETE
    process.env.GX_AUTHZ_ENGINE = "shadow";
    const res = await call("DELETE", `/api/kb/${disposable}`, "ke_owner");
    expect(res.status).toBe(200);
    expectNoDrift();
    const gone = await h.prisma.knowledgeBase.findUnique({ where: { id: disposable }, select: { deletedAt: true } });
    expect(gone?.deletedAt).not.toBeNull();
  });
});

describe("shadow：人为制造 manage_share 提级漂移，旧提级判断仍为准", () => {
  it("给 editor 在 kb 节点直授 manage_share -> PATCH 旧仍 403，引擎 allow，DRIFT_OVERALLOW=1", async () => {
    const kbId = await makeKb("ke_owner", [["ke_editor", "editor"]]);
    const node = await kbNodeId(kbId);
    // reconcile 已投影 editor 的 kb 行（c,comment,d,r,u，无 manage_share）；同键 update 追加 manage_share，
    // 模拟"策略比旧角色宽"。字典序存储串：c,comment,d,manage_share,r,u。
    const upd = await h.prisma.authPolicy.updateMany({
      where: { nodeId: node, subjectType: "user", subjectId: "ke_editor" },
      data: { actions: "c,comment,d,manage_share,r,u" },
    });
    expect(upd.count).toBe(1);
    driftRegistry.reset();
    const res = await call("PATCH", `/api/kb/${kbId}`, "ke_editor", { name: "hack" });
    expect(res.status).toBe(403); // 旧 owner-only 判断为准，引擎越权结论不放行
    const s = driftRegistry.snapshot();
    expect(s.overAllow).toBe(1);
    expect(s.overDeny).toBe(0);
    expect(s.recent.some((e) => e.guard === "kb.rename" && e.action === "manage_share")).toBe(true);
  });
});
