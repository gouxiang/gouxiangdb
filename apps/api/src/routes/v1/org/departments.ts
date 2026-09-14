// M2/S3 /api/v1/org/departments 路由（薄控制器）。
//
// 分层：只取当前用户 + 解析参数 + 调 service + 组装资源本体响应；不含业务/事务。
// 读：登录用户全员可读（总监裁决 3）；写：requireOrgAction("manage_departments")。
// 响应风格沿用现网：成功返资源本体/数组，错误经 app.onError -> {error,code}。

import { Hono } from "hono";
import { requireOrgAction } from "../../../middleware/authActive.js";
import * as deptService from "../../../domain/org/departments.js";
import type { CreateDeptInput, UpdateDeptInput } from "../../../domain/org/departments.js";
import { audit } from "../../../audit/emit.js";

export const departments = new Hono();

// 平铺列表（树组装在前端）：GET /org/departments
departments.get("/", async (c) => {
  const items = await deptService.listDepartments();
  return c.json(items);
});

// 建部门：POST /org/departments {name, parentId?, ord?} -> 201
departments.post("/", requireOrgAction("manage_departments"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  const created = await deptService.createDepartment(body as CreateDeptInput);
  audit(c, {
    event: "department_created",
    status: 201,
    actorId: c.get("auth").userId,
    detail: { departmentId: created.id, parentId: created.parentId },
  });
  return c.json(created, 201);
});

// 改名/排序/移动：PATCH /org/departments/:id {name?,ord?,parentId?}
departments.patch("/:id", requireOrgAction("manage_departments"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少部门 id", code: "BAD_REQUEST" }, 400);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  const updated = await deptService.updateDepartment(id, body as UpdateDeptInput);
  if (body.parentId !== undefined) {
    audit(c, {
      event: "department_moved",
      status: 200,
      actorId: c.get("auth").userId,
      detail: { departmentId: id, newParentId: updated.parentId },
    });
  }
  return c.json(updated);
});

// 软删：DELETE /org/departments/:id（有子部门/成员 -> 409 带 counts）
departments.delete("/:id", requireOrgAction("manage_departments"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少部门 id", code: "BAD_REQUEST" }, 400);
  const result = await deptService.deleteDepartment(id);
  audit(c, {
    event: "department_deleted",
    status: 200,
    actorId: c.get("auth").userId,
    detail: { departmentId: id },
  });
  return c.json(result);
});
