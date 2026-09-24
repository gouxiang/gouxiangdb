// P1/S6 表级管理守卫真库集成测试（临时库 + 真迁移 + 真 JWT）。
// 覆盖四用户（超管/管理员/可管自定义/只读自定义）在三个守卫上的 off 态放行矩阵，
// 以及表不存在 404。零 mock 授权。
//
// 关键：守卫/HttpError 均在 beforeAll 注入临时 client 后【动态 import】——
// 静态 import 会在收集期（globalThis.__gx_prisma 注入前）连带求值 db.js，
// db 单例绑错库导致 getUserId 恒 401。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { makeNavHarness, type CharHarness } from "../../../domain/nav/__tests__/navRouteHarness.js";

let h: CharHarness;
let HttpErrorCtor: typeof import("../../../httpError.js").HttpError;
let guards: typeof import("../tableManageGuards.js");

beforeAll(async () => {
  h = await makeNavHarness("gx-s6-tm-guards-");
  await h.createUser("super");
  await h.createUser("admin");
  await h.createUser("mgr");
  await h.createUser("viewer");
  await h.grantRole("super");
  await h.grantRole("admin", "role_admin");
  const { prisma } = h;
  await prisma.role.create({ data: { id: "r_mgr", workspaceId: "ws_default", name: "rm", isSystem: 0, permissions: "[]" } });
  await prisma.role.create({ data: { id: "r_view", workspaceId: "ws_default", name: "rv", isSystem: 0, permissions: "[]" } });
  await h.grantRole("mgr", "r_mgr");
  await h.grantRole("viewer", "r_view");

  await prisma.base.create({ data: { id: "b1", name: "b1", createdBy: "super" } });
  await prisma.table.create({
    data: { id: "t1", baseId: "b1", name: "t1", primaryFieldId: "t1_f1", createdBy: "super" },
  });
  await prisma.field.create({ data: { id: "t1_f1", tableId: "t1", name: "名称", type: "singleLineText", order: 0 } });
  await prisma.roleLibraryScope.create({
    data: { roleId: "r_mgr", libraryKind: "base", libraryId: "b1", visible: 1, canManage: 1, config: "{}" },
  });
  await prisma.roleLibraryScope.create({
    data: { roleId: "r_view", libraryKind: "base", libraryId: "b1", visible: 1, canManage: 0, config: "{}" },
  });

  HttpErrorCtor = (await import("../../../httpError.js")).HttpError;
  guards = await import("../tableManageGuards.js");
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

const USERS = ["super", "admin", "mgr", "viewer"] as const;
const ALLOWED_MANAGE = { super: true, admin: false, mgr: true, viewer: false } as const;

async function statusFor(
  user: string,
  guard: (c: import("hono").Context, id: string) => Promise<unknown>,
  id: string,
): Promise<number> {
  const app = new Hono();
  app.get("/:id", async (c) => {
    await guard(c, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.onError((e, c) => {
    if (e instanceof HttpErrorCtor) {
      return c.json({ error: e.message }, e.status as 403 | 404);
    }
    throw e;
  });
  const res = await app.request(`/${id}`, { headers: await h.auth(user) });
  return res.status;
}

describe("off 态：表级管理守卫放行矩阵", () => {
  it("requireCreateTable（base 节点 manage_schema）", async () => {
    for (const u of USERS) {
      expect(await statusFor(u, guards.requireCreateTable, "b1"), u).toBe(ALLOWED_MANAGE[u] ? 200 : 403);
    }
  });

  it("requireTableManage（manage_table）", async () => {
    for (const u of USERS) {
      expect(await statusFor(u, guards.requireTableManage, "t1"), u).toBe(ALLOWED_MANAGE[u] ? 200 : 403);
    }
  });

  it("requireSchemaDesign（manage_schema）", async () => {
    for (const u of USERS) {
      expect(await statusFor(u, guards.requireSchemaDesign, "t1"), u).toBe(ALLOWED_MANAGE[u] ? 200 : 403);
    }
  });

  it("表不存在：requireTableManage/requireSchemaDesign 返回 404", async () => {
    expect(await statusFor("super", guards.requireTableManage, "nope")).toBe(404);
    expect(await statusFor("super", guards.requireSchemaDesign, "nope")).toBe(404);
  });
});
