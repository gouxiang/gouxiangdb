// apps/api/src/routes/views.ts
// 视图 CRUD + 配置更新 + 复制

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx } from "../db.js";
import { requireCanView, requireCanManageSchema, HttpError } from "../guards.js";
import { parseViewConfig } from "../domain/recordService.js";
import { permissionsForRole } from "@gx/shared-types";
import { syncNavFromEntitiesTx, purgeViewNodeTx } from "../domain/nav/sync.js";

export const views = new Hono();

const VIEW_TYPE_ENUM = z.enum(["grid", "gallery", "form", "detail", "kanban", "calendar"]);

const createSchema = z.object({
  name: z.string().min(1).max(60),
  type: VIEW_TYPE_ENUM,
  config: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  lockMode: z.enum(["collaborative", "locked", "personal"]).optional(),
  order: z.number().int().min(0).optional(),
  config: z.record(z.unknown()).optional(),
});

async function baseIdOfTable(tableId: string): Promise<string> {
  const t = await prisma.table.findUnique({ where: { id: tableId }, select: { baseId: true } });
  if (!t) throw new HttpError(404, "数据表不存在");
  return t.baseId;
}

async function baseIdOfView(viewId: string): Promise<string> {
  const v = await prisma.view.findUnique({
    where: { id: viewId },
    select: { table: { select: { baseId: true } }, tableId: true, lockMode: true },
  });
  if (!v) throw new HttpError(404, "视图不存在");
  return v.table.baseId;
}

function serializeView(v: {
  id: string;
  tableId: string;
  name: string;
  type: string;
  lockMode: string;
  order: number;
  config: string;
  createdAt: Date;
}) {
  return {
    id: v.id,
    tableId: v.tableId,
    name: v.name,
    type: v.type,
    lockMode: v.lockMode,
    order: v.order,
    config: parseViewConfig(v.config),
    createdAt: v.createdAt.toISOString(),
  };
}

// ============ 列表 ============

views.get("/", async (c) => {
  const tableId = c.req.query("tableId");
  if (!tableId) return c.json({ error: "缺少 tableId" }, 400);
  const baseId = await baseIdOfTable(tableId);
  await requireCanView(c, baseId);

  const rows = await prisma.view.findMany({
    where: { tableId },
    orderBy: { order: "asc" },
  });
  return c.json({ views: rows.map(serializeView) });
});

// ============ 创建 ============

views.post("/", async (c) => {
  const tableId = c.req.query("tableId");
  if (!tableId) return c.json({ error: "缺少 tableId" }, 400);
  const baseId = await baseIdOfTable(tableId);
  await requireCanManageSchema(c, baseId);

  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);

  const maxOrder = await prisma.view.findFirst({
    where: { tableId },
    orderBy: { order: "desc" },
    select: { order: true },
  });
  const order = maxOrder ? maxOrder.order + 1 : 0;

  const merged = {
    ...parseViewConfig(null),
    ...(parsed.data.config ?? {}),
  };

  // M3/S3 #8：原裸写收紧进事务，同事务 upsert view 节点。
  const v = await withWriteTx("view.create", async (tx) => {
    const created = await tx.view.create({
      data: {
        tableId,
        name: parsed.data.name,
        type: parsed.data.type,
        order,
        config: JSON.stringify(merged),
        lockMode: "collaborative",
      },
    });
    await syncNavFromEntitiesTx(tx);
    return created;
  });
  return c.json({ view: serializeView(v) }, 201);
});

// ============ 详情 ============

views.get("/:viewId", async (c) => {
  const viewId = c.req.param("viewId");
  const baseId = await baseIdOfView(viewId);
  await requireCanView(c, baseId);
  const v = await prisma.view.findUnique({ where: { id: viewId } });
  if (!v) throw new HttpError(404, "视图不存在");
  return c.json({ view: serializeView(v) });
});

// ============ 更新（含配置）============

views.patch("/:viewId", async (c) => {
  const viewId = c.req.param("viewId");
  const baseId = await baseIdOfView(viewId);
  const { role } = await requireCanView(c, baseId);

  const v = await prisma.view.findUnique({ where: { id: viewId } });
  if (!v) throw new HttpError(404, "视图不存在");

  // 锁定视图只有 schema 权限者可改；个人视图允许成员调整自己的视图配置
  const perm = permissionsForRole(role);
  const isPersonal = v.lockMode === "personal";
  if (!isPersonal && !perm.canManageSchema) {
    throw new HttpError(403, "该视图已锁定，当前角色无权修改");
  }

  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);

  const data: Record<string, unknown> = {};
  // personal 视图当前是全成员共享的单一配置（模型无 per-user 存储）：
  // 无 schema 权限者只能调整 config（筛选/分组等使用态配置），
  // 不可改动 name/lockMode/order 等元数据，防止低权限成员干扰他人或提权改锁模式。
  const metaAllowed = isPersonal ? perm.canManageSchema : true;
  if (parsed.data.name !== undefined) {
    if (!metaAllowed) throw new HttpError(403, "个人视图的名称只有表结构管理者可修改");
    data["name"] = parsed.data.name;
  }
  if (parsed.data.lockMode !== undefined) {
    if (!perm.canManageSchema) throw new HttpError(403, "视图锁定模式只有表结构管理者可修改");
    data["lockMode"] = parsed.data.lockMode;
  }
  if (parsed.data.order !== undefined) {
    if (!metaAllowed) throw new HttpError(403, "个人视图的排序只有表结构管理者可修改");
    data["order"] = parsed.data.order;
  }
  if (parsed.data.config !== undefined) {
    const current = parseViewConfig(v.config);
    data["config"] = JSON.stringify({ ...current, ...parsed.data.config });
  }

  // M3/S3 #9：仅 name/order 影响 nav 节点（ord 镜像 view.order）；这两类变更收紧进事务
  // 并同步节点。lockMode/config 不进树，保持原裸写以最小化触碰。
  const affectsNav = Object.prototype.hasOwnProperty.call(data, "name") ||
    Object.prototype.hasOwnProperty.call(data, "order");
  const updated = affectsNav
    ? await withWriteTx("view.update", async (tx) => {
      const u = await tx.view.update({ where: { id: viewId }, data });
      await syncNavFromEntitiesTx(tx);
      return u;
    })
    : await prisma.view.update({ where: { id: viewId }, data });
  return c.json({ view: serializeView(updated) });
});

// ============ 删除 ============

views.delete("/:viewId", async (c) => {
  const viewId = c.req.param("viewId");
  const baseId = await baseIdOfView(viewId);
  await requireCanManageSchema(c, baseId);

  const v = await prisma.view.findUnique({ where: { id: viewId } });
  if (!v) throw new HttpError(404, "视图不存在");

  const count = await prisma.view.count({ where: { tableId: v.tableId } });
  if (count <= 1) throw new HttpError(400, "至少保留一个视图");

  // M3/S3 #10：物理删收紧进事务；先 RESTRICT 守卫（节点被菜单引用则 409，不静默级联删菜单），
  // 再删实体与节点（顺序无关紧要，同事务共生死）。
  await withWriteTx("view.purge", async (tx) => {
    await purgeViewNodeTx(tx, viewId);
    await tx.view.delete({ where: { id: viewId } });
  });
  return c.json({ ok: true });
});

// ============ 复制 ============

views.post("/:viewId/duplicate", async (c) => {
  const viewId = c.req.param("viewId");
  const baseId = await baseIdOfView(viewId);
  await requireCanManageSchema(c, baseId);

  const v = await prisma.view.findUnique({ where: { id: viewId } });
  if (!v) throw new HttpError(404, "视图不存在");

  const maxOrder = await prisma.view.findFirst({
    where: { tableId: v.tableId },
    orderBy: { order: "desc" },
    select: { order: true },
  });

  // M3/S3（baseline 偏差补接，§4.4 18 点之外的第 19 处实体写点）：视图复制产生新活 view，
  // 同样必须 upsert 节点，否则 reconcile 报 A1。收紧进事务同生共死。
  const copy = await withWriteTx("view.duplicate", async (tx) => {
    const created = await tx.view.create({
      data: {
        tableId: v.tableId,
        name: `${v.name} 副本`,
        type: v.type,
        order: (maxOrder?.order ?? 0) + 1,
        config: v.config,
        lockMode: v.lockMode,
      },
    });
    await syncNavFromEntitiesTx(tx);
    return created;
  });
  return c.json({ view: serializeView(copy) }, 201);
});
