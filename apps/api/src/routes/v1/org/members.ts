// M2/S4 /api/v1/org/members 路由（薄控制器）。
// 读：登录用户全员可读（总监裁决 3）；写：requireOrgAction("manage_members")。
// 停用/重新激活端点在 S6 于本文件追加。

import { Hono } from "hono";
import { requireOrgAction } from "../../../middleware/authActive.js";
import * as members from "../../../domain/org/members.js";
import { effectiveRoleRows } from "../../../domain/org/authorization.js";

export const memberRoutes = new Hono();

// 注意：Hono 按注册顺序匹配，静态段 /me 必须在 /:id 之前注册。
memberRoutes.get("/me/effective-roles", async (c) => {
  const auth = c.get("auth");
  const roles = await effectiveRoleRows(auth.userId);
  return c.json({ userId: auth.userId, roles });
});

// 成员目录分页：GET /org/members?page&limit(<=100)&q&deptId&status
memberRoutes.get("/", async (c) => {
  const page = membersPageQuery(c);
  const result = await members.listMembers(page);
  return c.json(result);
});

// 成员详情：GET /org/members/:id
memberRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const found = await members.getMemberById(id);
  if (!found) return c.json({ error: "成员不存在", code: "NOT_FOUND" }, 404);
  return c.json(found);
});

// 指定成员有效组织角色（直接授予 ∪ 活部门祖先闭包，附来源）：GET /org/members/:id/effective-roles
memberRoutes.get("/:id/effective-roles", async (c) => {
  const id = c.req.param("id");
  const target = await members.getMemberById(id);
  if (!target) return c.json({ error: "成员不存在", code: "NOT_FOUND" }, 404);
  const roles = await effectiveRoleRows(id);
  return c.json({ userId: id, roles });
});

// 邀请：POST /org/members/invite {email,displayName} -> 201，明文激活码仅本次返回
memberRoutes.post("/invite", requireOrgAction("manage_members"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  const result = await members.createInvitedUser(body);
  return c.json(result, 201);
});

// 直接建 ACTIVE 账号：POST /org/members {email,displayName,password}
memberRoutes.post("/", requireOrgAction("manage_members"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  const result = await members.createActiveUser(body);
  return c.json(result, 201);
});

// 调岗/兼岗：POST /org/members/:id/departments {add?,remove?,mainDeptId?}
memberRoutes.post("/:id/departments", requireOrgAction("manage_members"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少成员 id", code: "BAD_REQUEST" }, 400);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  const actorId = c.get("auth").userId;
  const result = await members.assignDepartments(actorId, id, body);
  return c.json(result);
});

function membersPageQuery(c: { req: { query: (k: string) => string | undefined } }) {
  const num = (k: string): unknown => {
    const v = c.req.query(k);
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  };
  const str = (k: string): unknown => {
    const v = c.req.query(k);
    return v === undefined || v === "" ? undefined : v;
  };
  return {
    page: num("page"),
    limit: num("limit"),
    q: str("q"),
    deptId: str("deptId"),
    status: str("status"),
  };
}
