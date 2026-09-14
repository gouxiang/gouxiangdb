// M2/S5 /api/v1/org/roles 路由（薄控制器）。
// 读登录可读；角色写与授予维护均需 manage_roles。成功返资源本体/数组，错误 {error,code}。

import { Hono } from "hono";
import { requireOrgAction } from "../../../middleware/authActive.js";
import * as roleAdmin from "../../../domain/org/roleAdmin.js";

export const roles = new Hono();

// GET /org/roles：系统角色固定序在前 + 自定义
roles.get("/", async (c) => c.json(await roleAdmin.listRoles()));

// POST /org/roles {name,description?,actions?} -> 201（动作白名单在 service 校验，非法 400）
roles.post("/", requireOrgAction("manage_roles"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  return c.json(await roleAdmin.createCustomRole(body), 201);
});

// PATCH /org/roles/:id（系统角色仅 description）
roles.patch("/:id", requireOrgAction("manage_roles"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少角色 id", code: "BAD_REQUEST" }, 400);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  return c.json(await roleAdmin.updateRole(id, body));
});

// DELETE /org/roles/:id?reassignTo=roleId（有悬挂授予 -> 409 带数）
roles.delete("/:id", requireOrgAction("manage_roles"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少角色 id", code: "BAD_REQUEST" }, 400);
  const reassignTo = c.req.query("reassignTo");
  return c.json(await roleAdmin.deleteRole(id, reassignTo));
});

// GET /org/roles/:id/assignments
roles.get("/:id/assignments", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少角色 id", code: "BAD_REQUEST" }, 400);
  return c.json(await roleAdmin.listAssignments(id));
});

// PUT /org/roles/:id/assignments {subjects:[{subjectType,subjectId}]} 批量 diff 替换
roles.put("/:id/assignments", requireOrgAction("manage_roles"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少角色 id", code: "BAD_REQUEST" }, 400);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  const actorId = c.get("auth").userId;
  return c.json(await roleAdmin.replaceAssignments(actorId, id, body));
});
