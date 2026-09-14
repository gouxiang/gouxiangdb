// M3/S0 特征测试（三）：旧资源 RBAC【现状】矩阵锁（真库 + 真 JWT + 真守卫，经 HTTP）。
//
// M3 的 nav tree/menu 是新增读路径，计划 §3-2 红线：nav 接线前后
// requireCanView/EditData/ManageSchema/ManageBase/Comment 与 requireKb/requireDocAccess
// 结果逐值不变；M3 不引 auth_policies 判定（空表冻结）。S11 必须复跑本文件全绿。
//
// base 五角色：owner/creator/editor/commenter/viewer；kb 四角色：owner/editor/commenter/viewer。
// 对照源：packages/shared-types/src/permissions.ts MATRIX。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupCharHarness, json, type CharHarness } from "./charHarness.js";
import type { Role } from "@gx/shared-types";

let h: CharHarness;
const BASE_ROLES: Role[] = ["owner", "creator", "editor", "commenter", "viewer"];

beforeAll(async () => {
  h = await setupCharHarness("gx-m3-rbac-");
  for (const r of BASE_ROLES) await h.createUser(`bu_${r}`, { email: `bu_${r}@example.com` });
  await h.createUser("bu_none", { email: "bu_none@example.com" });
  for (const r of ["owner", "editor", "commenter", "viewer"] as const) {
    await h.createUser(`ku_${r}`, { email: `ku_${r}@example.com` });
  }
});
afterAll(() => h.cleanup());

async function status(method: string, url: string, userId: string, body?: unknown): Promise<number> {
  const headers: Record<string, string> = await h.auth(userId);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await h.app.request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
}

describe("Base 资源守卫五角色矩阵（现状）", () => {
  let baseId: string;
  let tableId: string;
  let recordId: string;

  beforeAll(async () => {
    const res = await h.app.request("/api/bases", {
      method: "POST",
      headers: { ...(await h.auth("bu_owner")), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "RBAC 库" }),
    });
    baseId = (await json<{ base: { id: string } }>(res)).base.id;
    // owner 建库时已自动有 owner member；其余角色显式加入。
    for (const r of BASE_ROLES.filter((x) => x !== "owner")) {
      await h.prisma.member.create({ data: { baseId, userId: `bu_${r}`, role: r } });
    }
    const tRes = await h.app.request(`/api/tables?baseId=${baseId}`, { headers: await h.auth("bu_owner") });
    tableId = (await json<{ tables: Array<{ id: string }> }>(tRes)).tables[0]!.id;
    const rec = await h.prisma.record.create({
      data: { tableId, fields: "{}", createdBy: "bu_owner", updatedBy: "bu_owner" },
    });
    recordId = rec.id;
  });

  // GET /api/tables 需 canView：五角色 200，非成员 403。
  it.each(BASE_ROLES)("viewer 以上可看表列表：%s -> 200", async (r) => {
    expect(await status("GET", `/api/tables?baseId=${baseId}`, `bu_${r}`)).toBe(200);
  });
  it("非成员看表列表 403，无 token 401", async () => {
    expect(await status("GET", `/api/tables?baseId=${baseId}`, "bu_none")).toBe(403);
    const res = await h.app.request(`/api/tables?baseId=${baseId}`);
    expect(res.status).toBe(401);
  });

  // canManageSchema：owner/creator 可建表；editor/commenter/viewer 403。
  it.each(["owner", "creator"] as const)("%s 可建表 201", async (r) => {
    expect(
      await status("POST", `/api/tables?baseId=${baseId}`, `bu_${r}`, { name: `t-${r}` }),
    ).toBe(201);
  });
  it.each(["editor", "commenter", "viewer"] as const)("%s 建表 403", async (r) => {
    expect(
      await status("POST", `/api/tables?baseId=${baseId}`, `bu_${r}`, { name: `t-${r}` }),
    ).toBe(403);
  });

  // canEditData：owner/creator/editor 可建记录；commenter/viewer 403。
  it.each(["owner", "creator", "editor"] as const)("%s 可建记录 201", async (r) => {
    expect(await status("POST", "/api/records?tableId=" + tableId, `bu_${r}`, { fields: {} })).toBe(201);
  });
  it.each(["commenter", "viewer"] as const)("%s 建记录 403", async (r) => {
    expect(await status("POST", "/api/records?tableId=" + tableId, `bu_${r}`, { fields: {} })).toBe(403);
  });

  // canComment：owner/creator/editor/commenter 可评论；viewer 403。
  it.each(["owner", "creator", "editor", "commenter"] as const)("%s 可评论 201", async (r) => {
    expect(
      await status("POST", `/api/records/${recordId}/comments`, `bu_${r}`, { body: "x" }),
    ).toBe(201);
  });
  it("viewer 评论 403", async () => {
    expect(
      await status("POST", `/api/records/${recordId}/comments`, "bu_viewer", { body: "x" }),
    ).toBe(403);
  });

  // canManageBase：仅 owner 可加成员；其余四角色 403。
  it("owner 可加成员 201，非 owner 403", async () => {
    expect(
      await status("POST", `/api/bases/${baseId}/members`, "bu_owner", {
        email: "bu_none@example.com",
        role: "viewer",
      }),
    ).toBe(201);
    for (const r of ["creator", "editor", "commenter", "viewer"] as const) {
      expect(
        await status("POST", `/api/bases/${baseId}/members`, `bu_${r}`, {
          email: `extra-${r}@example.com`,
          role: "viewer",
        }),
      ).toBe(403);
    }
  });
});

describe("KB 资源守卫四角色矩阵（现状）", () => {
  let kbId: string;
  let docId: string;

  beforeAll(async () => {
    const res = await h.app.request("/api/kb", {
      method: "POST",
      headers: { ...(await h.auth("ku_owner")), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "RBAC 知识库" }),
    });
    kbId = (await json<{ knowledgeBase: { id: string } }>(res)).knowledgeBase.id;
    for (const r of ["editor", "commenter", "viewer"] as const) {
      await h.prisma.kbMember.create({ data: { kbId, userId: `ku_${r}`, role: r } });
    }
    const dRes = await h.app.request(`/api/kb/${kbId}/docs`, {
      method: "POST",
      headers: { ...(await h.auth("ku_owner")), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "doc" }),
    });
    docId = (await json<{ doc: { id: string } }>(dRes)).doc.id;
  });

  it("成员可列文档 200，非成员 403", async () => {
    for (const r of ["owner", "editor", "commenter", "viewer"] as const) {
      expect(await status("GET", `/api/kb/${kbId}/docs`, `ku_${r}`)).toBe(200);
    }
    expect(await status("GET", `/api/kb/${kbId}/docs`, "bu_none")).toBe(403);
  });

  it("owner/editor 可建内容；commenter/viewer 403", async () => {
    expect(
      await status("POST", `/api/kb/${kbId}/docs`, "ku_editor", { kind: "doc", title: "e" }),
    ).toBe(201);
    expect(
      await status("POST", `/api/kb/${kbId}/docs`, "ku_commenter", { kind: "doc", title: "c" }),
    ).toBe(403);
    expect(
      await status("POST", `/api/kb/${kbId}/docs`, "ku_viewer", { kind: "doc", title: "v" }),
    ).toBe(403);
  });

  it("内容保存需编辑权：owner 200，viewer 403", async () => {
    expect(
      await status("PUT", `/api/kb/docs/${docId}/content`, "ku_owner", { content: "x" }),
    ).toBe(200);
    expect(
      await status("PUT", `/api/kb/docs/${docId}/content`, "ku_viewer", { content: "y" }),
    ).toBe(403);
  });

  it("仅 kb owner 可删库/物理删文档；editor 403", async () => {
    expect(await status("DELETE", `/api/kb/docs/${docId}/permanent`, "ku_editor")).toBe(403);
    expect(await status("DELETE", `/api/kb/${kbId}`, "ku_editor")).toBe(403);
  });
});
