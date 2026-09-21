// M3/S0 特征测试（三）：资源守卫矩阵锁（真库 + 真 JWT + 真守卫，经 HTTP）。
//
// 权限核心模型（二）之前，本文件锁的是"base 五角色 / kb 四角色"两套【成员档】矩阵
// （owner/creator/editor/commenter/viewer）。成员档已整体退出放行链——库/表/字段的放行
// 只有一个来源：角色 × 库（role_library_scope）。故本文件改为锁同一批守卫在【新模型】
// 下的档位，成员行照旧写入只为证明它不再参与放行。
//
// 新模型档位与旧成员档不是一一对应，两处必须如实说明：
//   - 「可管理库」是一枚库级开关，覆盖旧 owner 的管成员 + creator 的改结构，不再分家；
//   - 新模型没有"评论者"这一档：评论权跟写权限走（见 guards.ts permit 的注释），
//     只读可见的人不能评论，故旧"commenter 可评论"这条不再成立。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KB_CONTENT_KEY } from "@gx/shared-types";
import { setupCharHarness, json, type CharHarness } from "./charHarness.js";

let h: CharHarness;

const BASE_USERS = ["bu_owner", "bu_creator", "bu_editor", "bu_commenter", "bu_viewer"] as const;
const KB_USERS = ["ku_owner", "ku_editor", "ku_commenter", "ku_viewer"] as const;

async function mkRole(id: string, name: string): Promise<string> {
  await h.prisma.role.create({
    data: { id, workspaceId: "ws_default", name, isSystem: 0, permissions: "[]" },
  });
  return id;
}
async function grant(roleId: string, userId: string): Promise<void> {
  await h.prisma.roleAssignment.create({
    data: { roleId, subjectType: "user", subjectId: userId, scopeType: "workspace", createdBy: "seed" },
  });
}
async function scope(
  roleId: string,
  libraryKind: "base" | "kb",
  libraryId: string,
  canManage: boolean,
  tables: Record<string, { read: boolean; create: boolean; update: boolean; delete: boolean }> = {},
): Promise<void> {
  await h.prisma.roleLibraryScope.create({
    data: {
      roleId, libraryKind, libraryId, canManage: canManage ? 1 : 0, visible: 1,
      config: JSON.stringify({ tables, fields: {} }),
    },
  });
}

beforeAll(async () => {
  h = await setupCharHarness("gx-m3-rbac-");
  for (const u of BASE_USERS) await h.createUser(u, { email: `${u}@example.com` });
  await h.createUser("bu_none", { email: "bu_none@example.com" });
  for (const u of KB_USERS) await h.createUser(u, { email: `${u}@example.com` });
  // 硬规则 B：只有超级管理员/管理员建得起库。
  await h.grantRole("bu_owner");
  await h.grantRole("ku_owner");
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

describe("Base 守卫：档位由「角色 × 库」决定，成员档不再参与", () => {
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
    // 旧成员行照旧写满五档——它仍是导航引擎的投影源，但对放行为零。
    await h.prisma.member.createMany({
      data: (BASE_USERS as readonly string[]).filter((u) => u !== "bu_owner")
        .map((u) => ({ baseId, userId: u, role: u.replace("bu_", "") })),
    });
    const tRes = await h.app.request(`/api/tables?baseId=${baseId}`, { headers: await h.auth("bu_owner") });
    tableId = (await json<{ tables: Array<{ id: string }> }>(tRes)).tables[0]!.id;
    const rec = await h.prisma.record.create({
      data: { tableId, fields: "{}", createdBy: "bu_owner", updatedBy: "bu_owner" },
    });
    recordId = rec.id;

    // 三档角色：可管理 / 可写（逐表勾 r+c+u）/ 只读。
    await grant(await mkRole("rb_manage", "库管理"), "bu_creator");
    await grant(await mkRole("rb_write", "库可写"), "bu_editor");
    const readRole = await mkRole("rb_read", "库只读");
    await grant(readRole, "bu_commenter");
    await grant(readRole, "bu_viewer");
    await scope("rb_manage", "base", baseId, true);
    await scope("rb_write", "base", baseId, false, {
      [tableId]: { read: true, create: true, update: true, delete: false },
    });
    await scope("rb_read", "base", baseId, false);
  });

  it("成员档自身不授予任何权限：未配视野的角色一律 403", async () => {
    // bu_commenter/bu_viewer 在配视野前什么都没有——先验证"只有成员行"确实无效。
    await h.prisma.roleLibraryScope.deleteMany({ where: { roleId: "rb_read" } });
    expect(await status("GET", `/api/tables?baseId=${baseId}`, "bu_commenter")).toBe(403);
    expect(await status("GET", `/api/tables?baseId=${baseId}`, "bu_viewer")).toBe(403);
    await scope("rb_read", "base", baseId, false);
  });

  it.each(BASE_USERS)("%s 看表列表 200（都已被角色视野覆盖）", async (u) => {
    expect(await status("GET", `/api/tables?baseId=${baseId}`, u)).toBe(200);
  });

  it("非成员看表列表 403，无 token 401", async () => {
    expect(await status("GET", `/api/tables?baseId=${baseId}`, "bu_none")).toBe(403);
    expect((await h.app.request(`/api/tables?baseId=${baseId}`)).status).toBe(401);
  });

  it("改结构 = 库级可管理：超级管理员与可管理角色 201，可写/只读 403", async () => {
    for (const u of ["bu_owner", "bu_creator"] as const) {
      expect(await status("POST", `/api/tables?baseId=${baseId}`, u, { name: `t-${u}` })).toBe(201);
    }
    for (const u of ["bu_editor", "bu_commenter", "bu_viewer"] as const) {
      expect(await status("POST", `/api/tables?baseId=${baseId}`, u, { name: `t-${u}` })).toBe(403);
    }
  });

  it("改数据 = 可管理或逐表勾选：owner/creator/editor 201，只读档 403", async () => {
    for (const u of ["bu_owner", "bu_creator", "bu_editor"] as const) {
      expect(await status("POST", `/api/records?tableId=${tableId}`, u, { fields: {} })).toBe(201);
    }
    for (const u of ["bu_commenter", "bu_viewer"] as const) {
      expect(await status("POST", `/api/records?tableId=${tableId}`, u, { fields: {} })).toBe(403);
    }
  });

  it("评论权跟写权限走：可写档 201，只读档 403", async () => {
    for (const u of ["bu_owner", "bu_creator", "bu_editor"] as const) {
      expect(await status("POST", `/api/records/${recordId}/comments`, u, { body: "x" })).toBe(201);
    }
    for (const u of ["bu_commenter", "bu_viewer"] as const) {
      expect(await status("POST", `/api/records/${recordId}/comments`, u, { body: "x" })).toBe(403);
    }
  });

  it("逐库成员增删端点已下线：POST/DELETE /api/bases/:id/members -> 404", async () => {
    expect(await status("POST", `/api/bases/${baseId}/members`, "bu_owner", {
      email: "bu_none@example.com", role: "viewer",
    })).toBe(404);
    expect(await status("DELETE", `/api/bases/${baseId}/members/bu_viewer`, "bu_owner")).toBe(404);
    expect(await status("GET", `/api/bases/${baseId}/members`, "bu_owner")).toBe(200);
  });
});

describe("KB 守卫：文档跟随知识库的角色配置", () => {
  let kbId: string;
  let docId: string;

  beforeAll(async () => {
    const res = await h.app.request("/api/kb", {
      method: "POST",
      headers: { ...(await h.auth("ku_owner")), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "RBAC 知识库" }),
    });
    kbId = (await json<{ knowledgeBase: { id: string } }>(res)).knowledgeBase.id;
    // 旧 kb_members 行照旧写入，同样只作台账。
    await h.prisma.kbMember.createMany({
      data: ["ku_editor", "ku_commenter", "ku_viewer"].map((u) => ({ kbId, userId: u, role: u.replace("ku_", "") })),
    });
    const dRes = await h.app.request(`/api/kb/${kbId}/docs`, {
      method: "POST",
      headers: { ...(await h.auth("ku_owner")), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "doc" }),
    });
    docId = (await json<{ doc: { id: string } }>(dRes)).doc.id;

    const writeRole = await mkRole("rb_kb_write", "知识库可写");
    await grant(writeRole, "ku_editor");
    await scope(writeRole, "kb", kbId, false, {
      [KB_CONTENT_KEY]: { read: true, create: true, update: true, delete: false },
    });
    const readRole = await mkRole("rb_kb_read", "知识库只读");
    await grant(readRole, "ku_commenter");
    await grant(readRole, "ku_viewer");
    await scope(readRole, "kb", kbId, false);
  });

  it("有视野者可列文档 200，无视野者 403", async () => {
    for (const u of KB_USERS) {
      expect(await status("GET", `/api/kb/${kbId}/docs`, u)).toBe(200);
    }
    expect(await status("GET", `/api/kb/${kbId}/docs`, "bu_none")).toBe(403);
  });

  it("建内容需 content 写动作：owner/editor 201，只读档 403", async () => {
    for (const u of ["ku_owner", "ku_editor"] as const) {
      expect(await status("POST", `/api/kb/${kbId}/docs`, u, { kind: "doc", title: `d-${u}` })).toBe(201);
    }
    for (const u of ["ku_commenter", "ku_viewer"] as const) {
      expect(await status("POST", `/api/kb/${kbId}/docs`, u, { kind: "doc", title: `d-${u}` })).toBe(403);
    }
  });

  it("内容保存需写动作：owner 200，viewer 403", async () => {
    expect(await status("PUT", `/api/kb/docs/${docId}/content`, "ku_owner", { content: "x" })).toBe(200);
    expect(await status("PUT", `/api/kb/docs/${docId}/content`, "ku_viewer", { content: "y" })).toBe(403);
  });

  it("硬规则 A：删库只有超级管理员；可管理档的 editor 也 403", async () => {
    expect(await status("DELETE", `/api/kb/docs/${docId}/permanent`, "ku_editor")).toBe(403);
    expect(await status("DELETE", `/api/kb/${kbId}`, "ku_editor")).toBe(403);
    // 可管理库同样不能删库：给 editor 的角色补上 canManage，删库仍须 403。
    await h.prisma.roleLibraryScope.updateMany({
      where: { roleId: "rb_kb_write", libraryId: kbId },
      data: { canManage: 1 },
    });
    expect(await status("DELETE", `/api/kb/${kbId}`, "ku_editor")).toBe(403);
  });
});
