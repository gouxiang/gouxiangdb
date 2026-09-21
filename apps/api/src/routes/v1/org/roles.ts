// M2/S5 /api/v1/org/roles 路由（薄控制器）。
// 读登录可读；角色写与授予维护均需 manage_roles。成功返资源本体/数组，错误 {error,code}。

import { Hono } from "hono";
import { requireOrgAction } from "../../../middleware/authActive.js";
import * as roleAdmin from "../../../domain/org/roleAdmin.js";
import { audit } from "../../../audit/emit.js";

export const roles = new Hono();

// GET /org/roles：系统角色固定序在前 + 自定义
// view_directory 门控：角色清单本身就是通讯录右栏的内容，能看通讯录才看得到有哪些角色；
// 此前登录即可读，等于向每个账号公开整套权限编排。
roles.get("/", requireOrgAction("view_directory"), async (c) => c.json(await roleAdmin.listRoles()));

// POST /org/roles {name,description?,actions?} -> 201（动作白名单在 service 校验，非法 400）
// 201：新建角色。旧门锁是 manage_roles 一枚；拆分后一律走 create_roles，
// 以便"能改角色但不能建角色"这类口径可表达。
roles.post("/", requireOrgAction("create_roles"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  const created = await roleAdmin.createCustomRole(body);
  audit(c, {
    event: "role_created",
    status: 201,
    actorId: c.get("auth").userId,
    detail: { roleId: created.id, isSystem: false },
  });
  return c.json(created, 201);
});

// PATCH /org/roles/:id（系统角色仅 description）
roles.patch("/:id", requireOrgAction("edit_roles"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少角色 id", code: "BAD_REQUEST" }, 400);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  return c.json(await roleAdmin.updateRole(id, body));
});

// DELETE /org/roles/:id?reassignTo=roleId（有悬挂授予 -> 409 带数）
roles.delete("/:id", requireOrgAction("delete_roles"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少角色 id", code: "BAD_REQUEST" }, 400);
  const reassignTo = c.req.query("reassignTo");
  const result = await roleAdmin.deleteRole(id, reassignTo);
  audit(c, {
    event: "role_deleted",
    status: 200,
    actorId: c.get("auth").userId,
    detail: { roleId: id, reassignedTo: reassignTo ?? null },
  });
  return c.json(result);
});

// GET /org/roles/:id/assignments
// 同 view_directory 门控：授予清单回答的是「谁持有这个角色」，与角色清单同一量级的
// 组织信息，不能因为新加了列表守卫却留这一个空着让人绕过去。
roles.get("/:id/assignments", requireOrgAction("view_directory"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少角色 id", code: "BAD_REQUEST" }, 400);
  return c.json(await roleAdmin.listAssignments(id));
});

// PUT /org/roles/:id/assignments {subjects:[{subjectType,subjectId}]} 批量 diff 替换
roles.put("/:id/assignments", requireOrgAction("assign_role_members"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少角色 id", code: "BAD_REQUEST" }, 400);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  const actorId = c.get("auth").userId;
  const result = await roleAdmin.replaceAssignments(actorId, id, body);
  if (result.added.length || result.removed.length) {
    audit(c, {
      event: "role_assignment_changed",
      status: 200,
      actorId,
      detail: { roleId: id, added: result.added, removed: result.removed },
    });
  }
  return c.json(result);
});
