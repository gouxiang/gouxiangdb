// apps/api/src/routes/views.ts
// 视图 CRUD + 配置更新 + 复制
//
// 管理员配置层（#560）端点已拆到 viewAdmin.ts 挂在同 /api/views 前缀，避免本文件超长。

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx } from "../db.js";
import { requireCanView, HttpError } from "../guards.js";
import { requireSchemaDesign } from "../domain/authz/tableManageGuards.js";
import { parseViewConfig } from "../domain/recordService.js";
import { createView, updateView, purgeView } from "../domain/viewService.js";
import { parseViewAdminConfig } from "../domain/viewAdminConfig.js";
import { loadUserPrefs, parseViewUserPrefs } from "../domain/viewUserPrefsStore.js";
import type { ViewUserPrefs } from "@gx/shared-types";
import { permissionsForRole } from "@gx/shared-types";
import { syncNavFromEntitiesTx } from "../domain/nav/sync.js";

export const views = new Hono();

const VIEW_TYPE_ENUM = z.enum([
  "grid",
  "gallery",
  "form",
  "detail",
  "kanban",
  "calendar",
  "tree",
  "gantt",
]);

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

/**
 * 序列化 View 行（含可空 adminConfig），供 views/viewAdmin/viewUserPrefs 三处共用。
 * userPrefs 默认 null：序列化器无"当前用户"上下文，由各 handler 查出后传入
 * （列表批量映射，单资源走 loadUserPrefs）。
 */
export function serializeView(
  v: {
    id: string; tableId: string; name: string; type: string;
    lockMode: string; order: number; config: string;
    adminConfig?: string | null; createdAt: Date;
  },
  userPrefs: ViewUserPrefs | null = null,
) {
  return {
    id: v.id,
    tableId: v.tableId,
    name: v.name,
    type: v.type,
    lockMode: v.lockMode,
    order: v.order,
    config: parseViewConfig(v.config),
    adminConfig: parseViewAdminConfig(v.adminConfig ?? null),
    userPrefs,
    createdAt: v.createdAt.toISOString(),
  };
}

// ============ 列表 ============

views.get("/", async (c) => {
  const tableId = c.req.query("tableId");
  if (!tableId) return c.json({ error: "缺少 tableId" }, 400);
  const baseId = await baseIdOfTable(tableId);
  const { userId } = await requireCanView(c, baseId);

  const rows = await prisma.view.findMany({
    where: { tableId },
    orderBy: { order: "asc" },
  });

  // #561：批量取当前用户在这些视图上的偏好（一次查询，避免逐视图 N+1）。
  const prefRows = await prisma.viewUserPref.findMany({
    where: { userId, viewId: { in: rows.map((r) => r.id) } },
    select: { viewId: true, prefs: true },
  });
  const prefByView = new Map(prefRows.map((r) => [r.viewId, r.prefs]));

  return c.json({
    views: rows.map((v) => {
      const raw = prefByView.get(v.id);
      return serializeView(v, raw === undefined ? null : parseViewUserPrefs(raw));
    }),
  });
});

// ============ 创建 ============

views.post("/", async (c) => {
  const tableId = c.req.query("tableId");
  if (!tableId) return c.json({ error: "缺少 tableId" }, 400);
  await baseIdOfTable(tableId);
  await requireSchemaDesign(c, tableId);

  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);

  const v = await createView({
    tableId,
    name: parsed.data.name,
    type: parsed.data.type,
    config: parsed.data.config,
  });
  const row = await prisma.view.findUniqueOrThrow({ where: { id: v.id } });
  return c.json({ view: serializeView(row) }, 201);
});

// ============ 详情 ============

views.get("/:viewId", async (c) => {
  const viewId = c.req.param("viewId");
  const baseId = await baseIdOfView(viewId);
  const { userId } = await requireCanView(c, baseId);
  const v = await prisma.view.findUnique({ where: { id: viewId } });
  if (!v) throw new HttpError(404, "视图不存在");
  const userPrefs = await loadUserPrefs(prisma, viewId, userId);
  return c.json({ view: serializeView(v, userPrefs) });
});

// ============ 更新（用户态 config；不碰 adminConfig）============

views.patch("/:viewId", async (c) => {
  const viewId = c.req.param("viewId");
  const baseId = await baseIdOfView(viewId);
  const { userId, role } = await requireCanView(c, baseId);

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
  let configChanged = false;
  if (parsed.data.config !== undefined) {
    const current = parseViewConfig(v.config);
    data["config"] = JSON.stringify({ ...current, ...parsed.data.config });
    configChanged = true;
  }

  // M3/S3 #9：仅 name/order 影响 nav 节点（ord 镜像 view.order）；这两类变更收紧进事务
  // 并同步节点。lockMode/config 不进树。
  //
  // 表单设计器版本管理：两条写路径统一收敛进 withWriteTx（原来 config-only 那条是裸写）。
  // 收敛后不再有"config 单独裸写"这条分支：nav 同步按 affectsNav 条件跑，布局快照按
  // configChanged 条件跑，二者互不干扰。快照必须在 update 之后取 u.config —— 装进去的
  // 是刚保存成功的那份布局，不是保存前的旧值。
  const affectsNav = Object.prototype.hasOwnProperty.call(data, "name") ||
    Object.prototype.hasOwnProperty.call(data, "order");
  // 事务体单一真源（domain/viewService -> viewServiceTx）；personal/锁定等权限分支留在路由。
  // 快照必须在 update 之后取 u.config（事务体内照此口径）。
  const updated = await updateView(viewId, {
    data,
    affectsNav,
    snapshot: configChanged
      ? { userId, tableId: v.tableId, viewType: v.type, skipIfIdentical: true }
      : null,
  });
  // #561：PATCH 返回也带当前用户的个性化（视图默认 config 被改不影响该用户已固化的偏好）。
  const userPrefs = await loadUserPrefs(prisma, viewId, userId);
  return c.json({ view: serializeView(updated, userPrefs) });
});

// ============ 删除 ============

views.delete("/:viewId", async (c) => {
  const viewId = c.req.param("viewId");
  const viewRow = await prisma.view.findUnique({
    where: { id: viewId },
    select: { tableId: true },
  });
  if (!viewRow) throw new HttpError(404, "视图不存在");
  await requireSchemaDesign(c, viewRow.tableId);

  // 至少保留一个视图 + 清 nav 节点/布局版本 + 物理删：统一由领域服务承载（单一真源）。
  await purgeView(viewId);
  return c.json({ ok: true });
});

// ============ 复制 ============

views.post("/:viewId/duplicate", async (c) => {
  const viewId = c.req.param("viewId");
  const viewRow = await prisma.view.findUnique({
    where: { id: viewId },
    select: { tableId: true, table: { select: { baseId: true } } },
  });
  if (!viewRow) throw new HttpError(404, "视图不存在");
  await requireSchemaDesign(c, viewRow.tableId);

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
