// M3/S6 /api/v1/nav/groups + /api/v1/nodes/:id/move(-impact) 路由（薄控制器）。
//
// 全部端点需 manage_menu（requireOrgAction）；只做参数解析 + 调域服务 + 审计 + 组装响应。
// move 未带 confirmed -> 409 MOVE_NEEDS_CONFIRM 并回带 impact 载荷（防误触，N6）。
// 根层目标统一用 "root" 哨兵（newParentId="root" -> null）。
// groups 挂 /api/v1/nav，move 挂 /api/v1/nodes（计划 §4.5 路径），两实例共享中间件。

import { Hono } from "hono";
import type { GroupDeleteStrategy } from "@gx/shared-types";
import { requireOrgAction } from "../../middleware/authActive.js";
import { withWriteTx, prisma } from "../../db.js";
import { audit } from "../../audit/emit.js";
import { createGroupTx, updateGroupTx, deleteGroupTx } from "../../domain/nav/groups.js";
import { moveImpactTx, moveNodeTx } from "../../domain/nav/move.js";

export const navRoutes = new Hono();
export const nodeRoutes = new Hono();
const manageMenu = requireOrgAction("manage_menu");

function normalizeParent(raw: string): string | null {
  return raw === "root" || raw === "" ? null : raw;
}

// ---- groups（/api/v1/nav/groups） ----

navRoutes.post("/groups", manageMenu, async (c) => {
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  const groupId = await withWriteTx("nav.group.create", (tx) =>
    createGroupTx(tx, {
      name: body.name as string,
      parentId: body.parentId === undefined || body.parentId === null
        ? null
        : normalizeParent(body.parentId as string),
      ord: body.ord as number | undefined,
      iconName: body.iconName as string | null | undefined,
    }));
  audit(c, {
    event: "nav_group_created", status: 201, actorId: c.get("auth").userId, detail: { groupId },
  });
  return c.json({ id: groupId }, 201);
});

navRoutes.patch("/groups/:id", manageMenu, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  await withWriteTx("nav.group.update", (tx) => updateGroupTx(tx, id, body));
  return c.json({ id });
});

navRoutes.delete("/groups/:id", manageMenu, async (c) => {
  const id = c.req.param("id")!;
  const q = c.req.query();
  const strategy = (q.strategy ?? undefined) as GroupDeleteStrategy | undefined;
  if (strategy && strategy !== "move" && strategy !== "retain") {
    return c.json({ error: "strategy 只能是 move 或 retain", code: "BAD_REQUEST" }, 400);
  }
  const targetParentId = q.targetParentId ? normalizeParent(q.targetParentId) : null;
  const result = await withWriteTx("nav.group.delete", (tx) =>
    deleteGroupTx(tx, id, strategy, targetParentId));
  audit(c, {
    event: "nav_group_deleted", status: 200, actorId: c.get("auth").userId,
    detail: { groupId: id, strategy: strategy ?? "empty", moved: result.moved },
  });
  return c.json(result);
});

// ---- node move（/api/v1/nodes/:id/...） ----

nodeRoutes.get("/:id/move-impact", manageMenu, async (c) => {
  const id = c.req.param("id")!;
  const targetRaw = c.req.query("newParentId");
  if (targetRaw === undefined || targetRaw === "") {
    return c.json({ error: "move-impact 必须带 newParentId（移到根层用 root）", code: "BAD_REQUEST" }, 400);
  }
  const impact = await prisma.$transaction((tx) => moveImpactTx(tx, id, normalizeParent(targetRaw)));
  return c.json(impact);
});

nodeRoutes.post("/:id/move", manageMenu, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => null) as {
    newParentId?: string; confirmed?: boolean;
  } | null;
  if (!body || typeof body.newParentId !== "string" || body.newParentId.trim() === "") {
    return c.json({ error: "move 必须带非空字符串 newParentId（移到根层用 root）", code: "BAD_REQUEST" }, 400);
  }
  const newParentId = normalizeParent(body.newParentId);
  if (!body.confirmed) {
    const impact = await prisma.$transaction((tx) => moveImpactTx(tx, id, newParentId));
    return c.json({ error: "移动需确认影响面后执行", code: "MOVE_NEEDS_CONFIRM", impact }, 409);
  }
  await withWriteTx("nav.node.move", (tx) => moveNodeTx(tx, id, newParentId));
  audit(c, {
    event: "nav_node_moved", status: 200, actorId: c.get("auth").userId,
    detail: { nodeId: id, newParentId },
  });
  return c.json({ id, newParentId });
});
