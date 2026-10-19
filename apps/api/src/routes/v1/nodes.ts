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
import { recordTreeOpTx } from "../../domain/sync/treeOplog.js";
import { recordLocalTreeReplicaTx } from "../../domain/sync/localOutbox.js";
import { offlineNodeId, offlineClientId } from "../../configOfflineReplica.js";

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
  const actorId = c.get("auth").userId;
  const parentId = body.parentId === undefined || body.parentId === null
    ? null
    : normalizeParent(body.parentId as string);
  const groupId = await withWriteTx("nav.group.create", async (tx) => {
    const gid = await createGroupTx(tx, {
      name: body.name as string,
      parentId,
      ord: body.ord as number | undefined,
      iconName: body.iconName as string | null | undefined,
    });
    // YN8 在线切面（§8.6/§19.6）：手动建组记树 op + 推进 treeVersion；off 时 recordTreeOpTx 首行 return null。
    const treeInput = {
      entityType: "navnode" as const, entityId: gid, op: "nav_create_group", actorId,
      payload: {
        name: body.name, parentId,
        ...(typeof body.ord === "number" ? { ord: body.ord } : {}),
      },
    };
    await recordTreeOpTx(tx, treeInput);
    // S2c：离线副本同事务落 local_outbox（默认关零行为；树回放走 navRegistry 不经本路由）。
    await recordLocalTreeReplicaTx(tx, treeInput, { nodeId: offlineNodeId(), clientId: offlineClientId() });
    return gid;
  });
  audit(c, {
    event: "nav_group_created", status: 201, actorId, detail: { groupId },
  });
  return c.json({ id: groupId }, 201);
});

navRoutes.patch("/groups/:id", manageMenu, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "请求体必须是 JSON 对象", code: "BAD_REQUEST" }, 400);
  const actorId = c.get("auth").userId;
  await withWriteTx("nav.group.update", async (tx) => {
    await updateGroupTx(tx, id, body);
    // YN8 在线切面：改名记 nav_rename；改 ord 记该父位【当前全兄弟】有序列表的 nav_reorder
    //（树 op 以集合为权威，离线端据此整组对账；不把单节点裸 ord 当 op）。
    if (body.name !== undefined) {
      const treeInput = {
        entityType: "navnode" as const, entityId: id, op: "nav_rename", actorId,
        payload: { name: body.name },
      };
      await recordTreeOpTx(tx, treeInput);
      // S2c：离线副本同事务落 local_outbox（默认关零行为；树回放不经本路由）。
      await recordLocalTreeReplicaTx(tx, treeInput, { nodeId: offlineNodeId(), clientId: offlineClientId() });
    }
    if (body.ord !== undefined) {
      const node = await tx.navNode.findUnique({ where: { id }, select: { parentId: true } });
      const sibs = await tx.navNode.findMany({
        where: { parentId: node?.parentId ?? null, deletedAt: null },
        orderBy: [{ depth: "asc" }, { ord: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const treeInput = {
        entityType: "navnode" as const, entityId: node?.parentId ?? "root", op: "nav_reorder", actorId,
        payload: { parentId: node?.parentId ?? null, orderedIds: sibs.map((s) => s.id) },
      };
      await recordTreeOpTx(tx, treeInput);
      // S2c：离线副本同事务落 local_outbox（默认关零行为；树回放不经本路由）。
      await recordLocalTreeReplicaTx(tx, treeInput, { nodeId: offlineNodeId(), clientId: offlineClientId() });
    }
  });
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
  const actorId = c.get("auth").userId;
  const result = await withWriteTx("nav.group.delete", async (tx) => {
    const r = await deleteGroupTx(tx, id, strategy, targetParentId);
    // YN8 在线切面：手动删组记树 op（含子节点处置策略，离线端按同策略对账）。
    const treeInput = {
      entityType: "navnode" as const, entityId: id, op: "nav_delete", actorId,
      payload: {
        ...(strategy ? { strategy } : {}),
        ...(targetParentId ? { targetParentId } : {}),
        moved: r.moved,
      },
    };
    await recordTreeOpTx(tx, treeInput);
    // S2c：离线副本同事务落 local_outbox（默认关零行为；树回放不经本路由）。
    await recordLocalTreeReplicaTx(tx, treeInput, { nodeId: offlineNodeId(), clientId: offlineClientId() });
    return r;
  });
  audit(c, {
    event: "nav_group_deleted", status: 200, actorId,
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
  const actorId = c.get("auth").userId;
  if (!body.confirmed) {
    const impact = await prisma.$transaction((tx) => moveImpactTx(tx, id, newParentId));
    return c.json({ error: "移动需确认影响面后执行", code: "MOVE_NEEDS_CONFIRM", impact }, 409);
  }
  await withWriteTx("nav.node.move", async (tx) => {
    await moveNodeTx(tx, id, newParentId);
    // YN8 在线切面（§19.6）：手动移动记树 op（path/depth 已由 moveNodeTx 服务端重算，oplog 只存目标父）。
    const treeInput = {
      entityType: "navnode" as const, entityId: id, op: "nav_move", actorId,
      payload: { to: { parentId: newParentId } },
    };
    await recordTreeOpTx(tx, treeInput);
    // S2c：离线副本同事务落 local_outbox（默认关零行为；树回放走 navRegistry 不经本路由）。
    await recordLocalTreeReplicaTx(tx, treeInput, { nodeId: offlineNodeId(), clientId: offlineClientId() });
  });
  audit(c, {
    event: "nav_node_moved", status: 200, actorId,
    detail: { nodeId: id, newParentId },
  });
  return c.json({ id, newParentId });
});
