// M4/S0 旧三表决策 characterization golden（只锁现状，不修正；禁改生产码）。
//
// 锁四件事，作为 S3 shadow 适配层包壳、S6 fieldMask 后 off 态逐值不变的对照源：
//   1. base 五角色 × 八操作 200/403 矩阵（真 HTTP/真 JWT/真守卫），并对拍 permissionsForRole；
//   2. kb 成员角色 × doc ACL「取较高」（kb.ts:68-69），含 team-lead 指定两路；
//   3. 无成员 / 无 ACL / 软删资源的 403/404 文案与机器 code；
//   4. 匿名 public resolveShare 路径零 members/kb_members/kb_doc_acls/auth_policies 查询。
// 真库真 17 迁移，复用 M3 charHarness（不 mock auth/守卫）。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { permissionsForRole, type Role } from "@gx/shared-types";
import { setupCharHarness, json, type CharHarness } from "../../../nav/__tests__/characterization/charHarness.js";

let h: CharHarness;
const BASE_ROLES: Role[] = ["owner", "creator", "editor", "commenter", "viewer"];

beforeAll(async () => {
  h = await setupCharHarness("gx-m4-decision-");
  for (const r of BASE_ROLES) await h.createUser(`bu_${r}`);
  await h.createUser("bu_none");
});
afterAll(() => h.cleanup());

async function call(method: string, url: string, userId: string | null, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = userId ? await h.auth(userId) : {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return h.app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function status(method: string, url: string, userId: string | null, body?: unknown): Promise<number> {
  return (await call(method, url, userId, body)).status;
}

describe("base 五角色 × 八操作矩阵（现状，对照 permissionsForRole）", () => {
  let baseId: string;
  let tableId: string;
  let detailRecordId: string;
  const recordByRole: Record<string, string> = {};

  beforeAll(async () => {
    const res = await call("POST", "/api/bases", "bu_owner", { name: "M4 决策库" });
    baseId = (await json<{ base: { id: string } }>(res)).base.id;
    for (const r of BASE_ROLES.filter((x) => x !== "owner")) {
      await h.prisma.member.create({ data: { baseId, userId: `bu_${r}`, role: r } });
    }
    const t = await call("GET", `/api/tables?baseId=${baseId}`, "bu_owner");
    tableId = (await json<{ tables: Array<{ id: string }> }>(t)).tables[0]!.id;
    // 给每个能编辑的角色预造一条独立记录，避免改/删互相干扰。
    for (const r of ["owner", "creator", "editor"]) {
      const rec = await h.prisma.record.create({
        data: { tableId, fields: "{}", createdBy: `bu_${r}`, updatedBy: `bu_${r}` },
      });
      recordByRole[r] = rec.id;
    }
    recordByRole.commenter = (await h.prisma.record.create({
      data: { tableId, fields: "{}", createdBy: "bu_owner", updatedBy: "bu_owner" },
    })).id;
    recordByRole.viewer = recordByRole.commenter;
    // 评论专用活记录（owner 自己那条会在改/删用例被软删）。
    recordByRole.commentTarget = (await h.prisma.record.create({
      data: { tableId, fields: "{}", createdBy: "bu_owner", updatedBy: "bu_owner" },
    })).id;
    // 详情专用活记录，不被任何改/删用例触碰。
    detailRecordId = (await h.prisma.record.create({
      data: { tableId, fields: "{}", createdBy: "bu_owner", updatedBy: "bu_owner" },
    })).id;
  });

  it.each(BASE_ROLES)("%s PermissionSet 与 MATRIX 一致", (r) => {
    const p = permissionsForRole(r);
    expect(p).toEqual({
      canManageBase: r === "owner",
      canManageSchema: r === "owner" || r === "creator",
      canEditData: r === "owner" || r === "creator" || r === "editor",
      canComment: r !== "viewer",
      canView: true,
    });
  });

  // 列表 / 详情 = canView：五角色 200。
  it.each(BASE_ROLES)("%s 列表(canView) 200", async (r) => {
    expect(await status("GET", `/api/tables?baseId=${baseId}`, `bu_${r}`)).toBe(200);
    expect(await status("GET", `/api/records/${detailRecordId}`, `bu_${r}`)).toBe(200);
  });

  // 建记录 = canEditData。
  it.each(["owner", "creator", "editor"] as Role[])("%s 建记录(canEditData) 201", async (r) => {
    expect(await status("POST", `/api/records?tableId=${tableId}`, `bu_${r}`, { fields: {} })).toBe(201);
  });
  it.each(["commenter", "viewer"] as Role[])("%s 建记录 403", async (r) => {
    expect(await status("POST", `/api/records?tableId=${tableId}`, `bu_${r}`, { fields: {} })).toBe(403);
  });

  // 改 / 删记录 = canEditData（用各角色独立记录）。
  it.each(["owner", "creator", "editor"] as Role[])("%s 改/删记录 200", async (r) => {
    const id = recordByRole[r]!;
    expect(await status("PATCH", `/api/records/${id}`, `bu_${r}`, { fields: {} })).toBe(200);
    expect(await status("DELETE", `/api/records/${id}`, `bu_${r}`)).toBe(200);
  });
  it.each(["commenter", "viewer"] as Role[])("%s 改/删记录 403", async (r) => {
    const id = recordByRole[r]!;
    expect(await status("PATCH", `/api/records/${id}`, `bu_${r}`, { fields: {} })).toBe(403);
    expect(await status("DELETE", `/api/records/${id}`, `bu_${r}`)).toBe(403);
  });

  // 改结构 = canManageSchema。
  it.each(["owner", "creator"] as Role[])("%s 建字段(canManageSchema) 201", async (r) => {
    expect(await status("POST", `/api/fields?tableId=${tableId}`, `bu_${r}`, { name: `f_${r}_${r}`, type: "singleLineText" })).toBe(201);
  });
  it.each(["editor", "commenter", "viewer"] as Role[])("%s 建字段 403", async (r) => {
    expect(await status("POST", `/api/fields?tableId=${tableId}`, `bu_${r}`, { name: `f_${r}`, type: "singleLineText" })).toBe(403);
  });

  // 管成员 = canManageBase：仅 owner（目标须为已注册用户，否则 404；先建账号）。
  it("管成员(canManageBase)：owner 201，其余 403", async () => {
    await h.createUser("member_target");
    expect(await status("POST", `/api/bases/${baseId}/members`, "bu_owner", { email: "member_target@example.com", role: "viewer" })).toBe(201);
    for (const r of ["creator", "editor", "commenter", "viewer"] as Role[]) {
      // 未注册邮箱先抛 404 也属拒绝，但为精确锁 403，用已存在账号（已是成员则 owner 成功，其余仍先过 canManageBase 403）。
      expect(await status("POST", `/api/bases/${baseId}/members`, `bu_${r}`, { email: "member_target@example.com", role: "viewer" })).toBe(403);
    }
  });

  // 评论 = canComment（用独立活记录）。
  it.each(["owner", "creator", "editor", "commenter"] as Role[])("%s 评论(canComment) 201", async (r) => {
    expect(await status("POST", `/api/records/${recordByRole.commentTarget}/comments`, `bu_${r}`, { body: "x" })).toBe(201);
  });
  it("viewer 评论 403", async () => {
    expect(await status("POST", `/api/records/${recordByRole.commentTarget}/comments`, "bu_viewer", { body: "x" })).toBe(403);
  });

  it("非成员全部资源操作 403 且 code=FORBIDDEN；无 token 401", async () => {
    const res = await call("GET", `/api/records?tableId=${tableId}`, "bu_none");
    expect(res.status).toBe(403);
    expect((await json<{ code: string }>(res)).code).toBe("FORBIDDEN");
    expect(await status("POST", `/api/records?tableId=${tableId}`, "bu_none", { fields: {} })).toBe(403);
    expect((await call("GET", `/api/tables?baseId=${baseId}`, null)).status).toBe(401);
  });
});

describe("kb 成员角色 × doc ACL「取较高」（kb.ts:68-69）", () => {
  let kbId: string;
  let docId: string;

  beforeAll(async () => {
    await h.createUser("ku_viewer");
    await h.createUser("ku_editor");
    await h.createUser("ku_commenter");
    await h.createUser("acl_editor");
    const res = await call("POST", "/api/kb", "bu_owner", { name: "M4 决策知识库" });
    kbId = (await json<{ knowledgeBase: { id: string } }>(res)).knowledgeBase.id;
    // owner（bu_owner）建库即 owner 成员；其余三个成员档显式加入。
    for (const [u, role] of [["ku_viewer", "viewer"], ["ku_editor", "editor"], ["ku_commenter", "commenter"]] as const) {
      await h.prisma.kbMember.create({ data: { kbId, userId: u, role } });
    }
    await h.createUser("acl_only_editor");
    const d = await call("POST", `/api/kb/${kbId}/docs`, "bu_owner", { kind: "doc", title: "ACL 文档" });
    docId = (await json<{ doc: { id: string } }>(d)).doc.id;
  });

  async function myRole(user: string): Promise<{ myRole: string; canEdit: boolean }> {
    const res = await call("GET", `/api/kb/docs/${docId}`, user);
    expect(res.status).toBe(200);
    const doc = (await json<{ doc: { myRole: string; canEdit: boolean } }>(res)).doc;
    return { myRole: doc.myRole, canEdit: doc.canEdit };
  }

  it("取较高①：viewer 成员 + editor ACL -> effective=editor，可编辑，PUT content 200", async () => {
    await h.prisma.kbDocAcl.create({ data: { docId, userId: "ku_viewer", role: "editor" } });
    expect(await myRole("ku_viewer")).toEqual({ myRole: "editor", canEdit: true });
    expect(await status("PUT", `/api/kb/docs/${docId}/content`, "ku_viewer", { content: "a" })).toBe(200);
  });

  it("取较高②：editor 成员 + viewer ACL -> 仍 editor（成员档不被 ACL 拉低），可编辑", async () => {
    await h.prisma.kbDocAcl.create({ data: { docId, userId: "ku_editor", role: "viewer" } });
    expect(await myRole("ku_editor")).toEqual({ myRole: "editor", canEdit: true });
    expect(await status("PUT", `/api/kb/docs/${docId}/content`, "ku_editor", { content: "b" })).toBe(200);
  });

  it("commenter 成员 + viewer ACL -> commenter，不可编辑，PUT 403", async () => {
    await h.prisma.kbDocAcl.create({ data: { docId, userId: "ku_commenter", role: "viewer" } });
    expect(await myRole("ku_commenter")).toEqual({ myRole: "commenter", canEdit: false });
    const res = await call("PUT", `/api/kb/docs/${docId}/content`, "ku_commenter", { content: "c" });
    expect(res.status).toBe(403);
    expect((await json<{ code: string; error: string }>(res)).error).toBe("当前角色无权编辑");
  });

  it("无成员但有 editor ACL -> 凭 ACL 可编辑", async () => {
    await h.prisma.kbDocAcl.create({ data: { docId, userId: "acl_only_editor", role: "editor" } });
    expect(await myRole("acl_only_editor")).toEqual({ myRole: "editor", canEdit: true });
  });

  it("无成员且无 ACL -> 403「无权访问该内容」code=FORBIDDEN", async () => {
    const res = await call("GET", `/api/kb/docs/${docId}`, "bu_none");
    expect(res.status).toBe(403);
    const b = await json<{ code: string; error: string }>(res);
    expect(b.code).toBe("FORBIDDEN");
    expect(b.error).toBe("无权访问该内容");
  });

  it("软删文档 404「文档不存在或已删除」；软删知识库 404「知识库不存在」", async () => {
    await h.prisma.kbDoc.update({ where: { id: docId }, data: { deletedAt: new Date(), deletedBy: "bu_owner" } });
    const r1 = await call("GET", `/api/kb/docs/${docId}`, "bu_owner");
    expect(r1.status).toBe(404);
    expect((await json<{ error: string }>(r1)).error).toBe("文档不存在或已删除");
    await h.prisma.kbDoc.update({ where: { id: docId }, data: { deletedAt: null, deletedBy: null } });
    await h.prisma.knowledgeBase.update({ where: { id: kbId }, data: { deletedAt: new Date() } });
    const r2 = await call("GET", `/api/kb/${kbId}`, "bu_owner");
    expect(r2.status).toBe(404);
    expect((await json<{ error: string }>(r2)).error).toBe("知识库不存在");
  });
});

describe("匿名 public resolveShare 不查成员/ACL/auth_policies", () => {
  let editorToken: string;
  let viewerToken: string;
  let childId: string;
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeAll(async () => {
    const kb = await h.prisma.knowledgeBase.create({ data: { name: "公开库", createdBy: "bu_owner" } });
    const root = await h.prisma.kbDoc.create({
      data: { id: "m4share_root", kbId: kb.id, kind: "doc", title: "分享根", content: "r", createdBy: "bu_owner", updatedBy: "bu_owner" },
    });
    childId = (await h.prisma.kbDoc.create({
      data: { kbId: kb.id, kind: "doc", title: "子文档", content: "c", parentId: root.id, createdBy: "bu_owner", updatedBy: "bu_owner" },
    })).id;
    await h.prisma.kbDoc.update({ where: { id: root.id }, data: { shareEnabled: true, shareToken: "tok-editor", shareRole: "editor", shareIncludeChildren: true } });
    const vRoot = await h.prisma.kbDoc.create({
      data: { kbId: kb.id, kind: "doc", title: "只读根", content: "v", createdBy: "bu_owner", updatedBy: "bu_owner" },
    });
    await h.prisma.kbDoc.update({ where: { id: vRoot.id }, data: { shareEnabled: true, shareToken: "tok-viewer", shareRole: "viewer" } });
    editorToken = "tok-editor";
    viewerToken = "tok-viewer";
  });

  beforeEach(() => {
    // 匿名通道经 db.js 同一 prisma 单例；spy 三类旧授权表的全部读方法。
    for (const delegate of ["kbMember", "kbDocAcl", "authPolicy"] as const) {
      for (const m of ["findUnique", "findFirst", "findMany", "count"] as const) {
        const spy = vi.spyOn((h.prisma as unknown as Record<string, Record<string, unknown>>)[delegate]!, m as never);
        spies.push(spy as never);
      }
    }
  });
  afterEach(() => { vi.restoreAllMocks(); spies.length = 0; });

  function assertNoAuthzQuery() {
    const total = spies.reduce((n, s) => n + s.mock.calls.length, 0);
    expect(total).toBe(0);
  }

  it("spy 反证：直接查 kbMember 会被计数（证明上面零计数非 spy 失效）", async () => {
    await h.prisma.kbMember.findUnique({ where: { kbId_userId: { kbId: "x", userId: "y" } } } as never);
    const total = spies.reduce((n, s) => n + s.mock.calls.length, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("GET 根：200 且零成员/ACL/policy 查询", async () => {
    const res = await h.app.request(`/api/public/s/${editorToken}`);
    expect(res.status).toBe(200);
    assertNoAuthzQuery();
  });

  it("GET 级联子文档 200；范围外 doc 404，均零授权查询", async () => {
    expect((await h.app.request(`/api/public/s/${editorToken}/doc/${childId}`)).status).toBe(200);
    assertNoAuthzQuery();
    const out = await h.app.request(`/api/public/s/${editorToken}/doc/${"doc_out_of_range_xx"}`);
    expect(out.status).toBe(404);
  });

  // 产品口径变更（M7）：分享链接对外只读，匿名写整体关闭。原用例断言 editor 分享可匿名 200 改写
  // 正文，与新口径相反，故改为断言两档分享一律 403，并强证正文/updatedBy 未被改动。
  it("匿名编辑已关闭：editor / viewer 分享一律 403「只读」，正文未改且零授权查询", async () => {
    const before = await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: childId } });
    const deniedEditor = await h.app.request(`/api/public/s/${editorToken}/doc/${childId}/content`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "anon" }),
    });
    expect(deniedEditor.status).toBe(403);
    expect((await json<{ error: string }>(deniedEditor)).error).toContain("只读");
    assertNoAuthzQuery();
    const deniedViewer = await h.app.request(`/api/public/s/${viewerToken}/doc/x/content`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "z" }),
    });
    expect(deniedViewer.status).toBe(403);
    const after = await h.prisma.kbDoc.findUniqueOrThrow({ where: { id: childId } });
    expect(after.content).toBe(before.content);
    expect(after.updatedBy).toBe(before.updatedBy);
  });
});
