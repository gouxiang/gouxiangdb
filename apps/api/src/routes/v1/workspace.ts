// M3/S5 /api/v1/workspaces/current/tree|menu 路由（薄控制器）。
//
// 分层：只取当前用户 + 解析查询参数 + 调领域服务 + 组装响应；不含业务规则。
// 登录用户全员可读（M3 零剪枝，总监裁决 1）；all=1 管理通道要求持有任意 manage_* 动作。
// 响应风格沿用现网：成功返资源本体，错误 {error,code}（错误码按 HTTP 状态映射）。

import { Hono } from "hono";
import { NAV_KINDS, type MenuOp, type NavKind } from "@gx/shared-types";
import { readNavTree, TreeQueryError, type TreeParams } from "../../domain/nav/workspace-read.js";
import { readMenuTree } from "../../domain/nav/menu-read.js";
import { applyMenuChangesTx } from "../../domain/nav/menu.js";
import { effectiveRoleRows } from "../../domain/org/authorization.js";
import { withWriteTx, prisma } from "../../db.js";
import { requireOrgAction } from "../../middleware/authActive.js";
import { audit } from "../../audit/emit.js";

export const workspaceRoutes = new Hono();

function isNavKind(value: string): value is NavKind {
  return (NAV_KINDS as readonly string[]).includes(value);
}

/** 当前用户是否为组织管理员（有效角色持有任意 manage_* 动作）。 */
async function isWorkspaceAdmin(userId: string): Promise<boolean> {
  const roles = await effectiveRoleRows(userId);
  return roles.some((r) => r.actions.length > 0);
}

function errorBody(status: number, message: string) {
  const code = status === 403 ? "FORBIDDEN" : "BAD_REQUEST";
  return { error: message, code } as const;
}

// 权威资源树读：?parentId=&maxDepth=&kind=&all=
workspaceRoutes.get("/current/tree", async (c) => {
  const q = c.req.query();
  const params: TreeParams = {};
  if (q.parentId !== undefined) params.parentId = q.parentId;
  if (q.kind !== undefined) {
    if (!isNavKind(q.kind)) {
      return c.json({ error: `未知 kind: ${q.kind}`, code: "BAD_REQUEST" }, 400);
    }
    params.kind = q.kind;
  }
  if (q.maxDepth !== undefined) {
    const n = Number(q.maxDepth);
    if (!Number.isInteger(n)) {
      return c.json({ error: "maxDepth 必须为整数", code: "BAD_REQUEST" }, 400);
    }
    params.maxDepth = n;
  }
  if (q.all !== undefined) params.all = q.all === "1" || q.all === "true";

  const admin = params.all ? await isWorkspaceAdmin(c.get("auth").userId) : false;
  try {
    const data = await prisma.$transaction((tx) => readNavTree(tx, params, admin));
    return c.json(data);
  } catch (e) {
    if (e instanceof TreeQueryError) return c.json(errorBody(e.status, e.message), e.status);
    throw e;
  }
});

// 菜单引用树读：全部活菜单项 + shortcut 节点摘要（state 三态）。
workspaceRoutes.get("/current/menu", async (c) => {
  const data = await prisma.$transaction((tx) => readMenuTree(tx));
  return c.json(data);
});

// 菜单编排写：整单批量 diff 单事务（manage_menu），全成功或 4xx 全拒。
workspaceRoutes.patch("/current/menu", requireOrgAction("manage_menu"), async (c) => {
  const body = await c.req.json().catch(() => null) as { operations?: unknown } | null;
  if (!body || !Array.isArray(body.operations) || body.operations.length === 0) {
    return c.json({ error: "operations 必须是非空数组", code: "BAD_REQUEST" }, 400);
  }
  const ops = body.operations as MenuOp[];
  const result = await withWriteTx("nav.menu.patch", (tx) => applyMenuChangesTx(tx, ops));
  audit(c, {
    event: "menu_changed", status: 200, actorId: c.get("auth").userId,
    detail: { ops: ops.length, menuVersion: result.menuVersion },
  });
  return c.json({ menuVersion: result.menuVersion, applied: result.itemIds.length, itemIds: result.itemIds });
});
