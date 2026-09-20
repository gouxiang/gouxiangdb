// M2/S4 /api/v1/org/members 路由（薄控制器）。
// 企业化定位：读统一由 view_directory 门控（此前任何登录用户都能拉全量成员，等于把通讯录
// 明文下发给每一个账号）；写从一枚 manage_members 拆成 invite_users / create_users /
// disable_users / delete_users 四枚，可按角色分别授予。
// 企业化定位：写动作按「成员账号」四件套分别授予。调岗/兼岗维持 manage_members 原门锁不变
// （见该文件头与 :departments 处的注释——改它会造成无迁移兑现的能力收回）。
//
// 迁移连续性：既有的「能管成员」角色由 20260920220000_org_directory_actions 一次性补齐这五枚，
// 所以本次拆分不会悄悄收回管理员已经派出去的能力。

import { Hono } from "hono";
import { requireOrgAction } from "../../../middleware/authActive.js";
import * as members from "../../../domain/org/members.js";
import { effectiveRoleRows } from "../../../domain/org/authorization.js";
import { deleteUser, disableUser, reactivateUser } from "../../../domain/org/lifecycle.js";
import { audit } from "../../../audit/emit.js";

export const memberRoutes = new Hono();

// 注意：Hono 按注册顺序匹配，静态段 /me 必须在 /:id 之前注册。
memberRoutes.get("/me/effective-roles", async (c) => {
  const auth = c.get("auth");
  const roles = await effectiveRoleRows(auth.userId);
  return c.json({ userId: auth.userId, roles });
});

// 成员目录分页：GET /org/members?page&limit(<=100)&q&deptId&status
memberRoutes.get("/", requireOrgAction("view_directory"), async (c) => {
  const page = membersPageQuery(c);
  const result = await members.listMembers(page);
  return c.json(result);
});

// 成员详情：GET /org/members/:id
memberRoutes.get("/:id", requireOrgAction("view_directory"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少成员 id", code: "BAD_REQUEST" }, 400);
  const found = await members.getMemberById(id);
  if (!found) return c.json({ error: "成员不存在", code: "NOT_FOUND" }, 404);
  return c.json(found);
});

// 指定成员有效组织角色（直接授予 ∪ 活部门祖先闭包，附来源）：GET /org/members/:id/effective-roles
memberRoutes.get("/:id/effective-roles", requireOrgAction("view_directory"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少成员 id", code: "BAD_REQUEST" }, 400);
  const target = await members.getMemberById(id);
  if (!target) return c.json({ error: "成员不存在", code: "NOT_FOUND" }, 404);
  const roles = await effectiveRoleRows(id);
  return c.json({ userId: id, roles });
});

// 邀请：POST /org/members/invite {email,displayName} -> 201，明文激活码仅本次返回
memberRoutes.post("/invite", requireOrgAction("invite_users"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  const actorId = c.get("auth").userId;
  const result = await members.createInvitedUser(body);
  audit(c, { event: "member_invited", status: 201, actorId, detail: { userId: result.userId } });
  return c.json(result, 201);
});

// 直接建 ACTIVE 账号：POST /org/members {email,displayName,password}
memberRoutes.post("/", requireOrgAction("create_users"), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  }
  const result = await members.createActiveUser(body);
  return c.json(result, 201);
});

// 调岗/兼岗：POST /org/members/:id/departments {add?,remove?,mainDeptId?}
// 维持 manage_members（不改为 manage_departments）：本次只拆「成员账号」四类动作，
// 不碰部門归属。改成 manage_departments 会让现网所有「有 manage_members、无
// manage_departments」的自定义角色在一次无声发布里丢掉调岗能力，而迁移
// 20260920220000 只补五枚新动作、不补 manage_departments，无迁移能兑现这种收回。
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

// 停用：POST /org/members/:id/disable（自停用 400、最后 owner 409）
memberRoutes.post("/:id/disable", requireOrgAction("disable_users"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少成员 id", code: "BAD_REQUEST" }, 400);
  const actorId = c.get("auth").userId;
  const result = await disableUser(actorId, id);
  audit(c, { event: "member_disabled", status: 200, actorId, detail: { targetId: id } });
  return c.json(result);
});

// 重新激活：POST /org/members/:id/reactivate（旧 token 仍失效，强制重登）
memberRoutes.post("/:id/reactivate", requireOrgAction("disable_users"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少成员 id", code: "BAD_REQUEST" }, 400);
  const actorId = c.get("auth").userId;
  const result = await reactivateUser(actorId, id);
  audit(c, { event: "member_reactivated", status: 200, actorId, detail: { targetId: id } });
  return c.json(result);
});

// 删除账号：DELETE /org/members/:id（自删 400、删后无在岗 owner 409）
// 物理删除——memberships/PAT/部门归属等已配级联；删除不可恢复，所以单独占一枚 delete_users，
// 不与停用共用同一个动词。级联覆盖不到的 role_assignments 授予行由 deleteUser 显式清理。
memberRoutes.delete("/:id", requireOrgAction("delete_users"), async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "缺少成员 id", code: "BAD_REQUEST" }, 400);
  const actorId = c.get("auth").userId;
  const result = await deleteUser(actorId, id);
  audit(c, {
    event: "member_deleted",
    status: 200,
    actorId,
    detail: { targetId: id, email: result.email },
  });
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
