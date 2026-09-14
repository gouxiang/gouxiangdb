// apps/api/src/routes/bases.ts
// Base CRUD + 成员管理 + 分享链接 + 统计

import { Hono } from "hono";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma, withWriteTx } from "../db.js";
import type { DbTx } from "../db.js";
import {
  requireUserId,
  requireCanView,
  requireCanManageBase,
  permissionsOf,
  HttpError,
} from "../guards.js";
import { permissionsForRole, type Role, type ViewConfig } from "@gx/shared-types";
import { makeOptions } from "../domain/fieldService.js";
import { syncNavFromEntitiesTx, softDeleteSubtreeTx } from "../domain/nav/sync.js";
import { nodeId } from "../domain/nav/backfill.js";

export const bases = new Hono();

const createSchema = z.object({
  name: z.string().min(1).max(80),
  iconColor: z.string().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  iconColor: z.string().optional(),
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["creator", "editor", "commenter", "viewer"]),
});

const updateMemberSchema = z.object({
  role: z.enum(["creator", "editor", "commenter", "viewer"]),
});

const shareSchema = z.object({
  role: z.enum(["editor", "commenter", "viewer"]),
  expiresAt: z.string().nullable().optional(),
});

// ============ 默认表结构 ============

async function createStarterTableTx(tx: DbTx, baseId: string, userId: string, name = "数据表 1") {
  const table = await tx.table.create({
    data: { baseId, name, primaryFieldId: "", createdBy: userId },
  });

  const nameField = await tx.field.create({
    data: { tableId: table.id, name: "名称", type: "singleLineText", order: 0 },
  });
  await tx.field.create({
    data: { tableId: table.id, name: "数量", type: "number", order: 1, precision: 0 },
  });
  await tx.field.create({
    data: {
      tableId: table.id,
      name: "状态",
      type: "singleSelect",
      order: 2,
      options: JSON.stringify(makeOptions(["未开始", "进行中", "已完成"])),
    },
  });
  await tx.field.create({
    data: { tableId: table.id, name: "日期", type: "date", order: 3 },
  });
  await tx.field.create({
    data: { tableId: table.id, name: "备注", type: "longText", order: 4 },
  });

  await tx.table.update({
    where: { id: table.id },
    data: { primaryFieldId: nameField.id },
  });

  const defaultConfig: ViewConfig = {
    hiddenFieldIds: [],
    fieldOrder: [],
    rowHeight: "medium",
    filters: null,
    sorts: [],
    search: "",
    groupByFieldId: null,
    collapsedGroupKeys: [],
    aggregations: {},
    rowColor: { mode: "none", conditions: [] },
    coverFieldId: null,
    cardFieldIds: [],
    kanbanFieldId: null,
    dateFieldId: null,
    formFields: [],
    formTitle: "",
    formDescription: "",
    detailFieldIds: [],
    detailLayout: null,
  };

  await tx.view.create({
    data: { tableId: table.id, name: "网格视图", type: "grid", order: 0, config: JSON.stringify(defaultConfig) },
  });

  return table;
}

// ============ 列表 ============

bases.get("/", async (c) => {
  const userId = await requireUserId(c);
  const members = await prisma.member.findMany({
    where: { userId },
    include: {
      base: {
        include: { _count: { select: { tables: { where: { deletedAt: null } } } } },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  const out = await Promise.all(
    members
      .filter((m) => !m.base.deletedAt)
      .map(async (m) => ({
        id: m.base.id,
        name: m.base.name,
        iconColor: m.base.iconColor,
        createdAt: m.base.createdAt.toISOString(),
        createdBy: m.base.createdBy,
        role: m.role as Role,
        permissions: permissionsForRole(m.role as Role),
        tableCount: m.base._count.tables,
      })),
  );
  return c.json({ bases: out });
});

// ============ 创建 ============

bases.post("/", async (c) => {
  const userId = await requireUserId(c);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);

  // M3/S3 #1：建 base 多步写（base+owner 成员+starter 表/字段/视图）收紧进单事务，
  // 同事务同步 nav_nodes（base + table + view 节点）。nav 写失败整体回滚（裁决 9）。
  const base = await withWriteTx("base.create", async (tx) => {
    const b = await tx.base.create({
      data: {
        name: parsed.data.name,
        iconColor: parsed.data.iconColor ?? "#378ADD",
        createdBy: userId,
      },
    });
    await tx.member.create({ data: { baseId: b.id, userId, role: "owner" } });
    await createStarterTableTx(tx, b.id, userId);
    await syncNavFromEntitiesTx(tx);
    return b;
  });

  return c.json({
    base: {
      id: base.id,
      name: base.name,
      iconColor: base.iconColor,
      createdAt: base.createdAt.toISOString(),
      createdBy: base.createdBy,
      role: "owner" as Role,
      permissions: permissionsForRole("owner"),
      tableCount: 1,
    },
  }, 201);
});

// ============ 详情 ============

bases.get("/:baseId", async (c) => {
  const userId = await requireUserId(c);
  const baseId = c.req.param("baseId");
  const perm = await permissionsOf(userId, baseId);
  if (!perm.canView) throw new HttpError(403, "无权访问该 Base");

  const base = await prisma.base.findUnique({
    where: { id: baseId },
    include: { _count: { select: { tables: { where: { deletedAt: null } } } } },
  });
  if (!base || base.deletedAt) throw new HttpError(404, "Base 不存在");

  const role = (await prisma.member.findUnique({
    where: { baseId_userId: { baseId, userId } },
    select: { role: true },
  }))?.role as Role;

  return c.json({
    base: {
      id: base.id,
      name: base.name,
      iconColor: base.iconColor,
      createdAt: base.createdAt.toISOString(),
      createdBy: base.createdBy,
      role,
      permissions: perm,
      tableCount: base._count.tables,
    },
  });
});

bases.patch("/:baseId", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanManageBase(c, baseId);
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);
  // M3/S3 #2：改名同事务同步节点 name（iconColor 不影响节点）。
  const base = await withWriteTx("base.rename", async (tx) => {
    const b = await tx.base.update({ where: { id: baseId }, data: parsed.data });
    await syncNavFromEntitiesTx(tx);
    return b;
  });
  return c.json({ base: { id: base.id, name: base.name, iconColor: base.iconColor } });
});

bases.delete("/:baseId", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanManageBase(c, baseId);
  const now = new Date();
  // M3/S3 #3：软删 base + 其下 tables 收紧进单事务；nav 子树（base/table/view）整棵软删。
  // view 实体行不碰 deletedAt（views 表无此列），其节点随 path 子树一并软删，恢复依赖对账。
  await withWriteTx("base.softDelete", async (tx) => {
    await tx.base.update({ where: { id: baseId }, data: { deletedAt: now } });
    await tx.table.updateMany({ where: { baseId }, data: { deletedAt: now } });
    await softDeleteSubtreeTx(tx, nodeId("base", baseId));
  });
  return c.json({ ok: true });
});

// ============ 统计 ============

bases.get("/:baseId/stats", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanView(c, baseId);
  const tables = await prisma.table.findMany({
    where: { baseId, deletedAt: null },
    select: { id: true },
  });
  const tableIds = tables.map((t) => t.id);
  const [recordCount, fieldCount, memberCount] = await Promise.all([
    prisma.record.count({ where: { tableId: { in: tableIds }, deletedAt: null } }),
    prisma.field.count({ where: { tableId: { in: tableIds }, deletedAt: null } }),
    prisma.member.count({ where: { baseId } }),
  ]);
  return c.json({
    stats: { tableCount: tables.length, recordCount, fieldCount, memberCount },
  });
});

// ============ ERD 关系图 ============
// 一次返回 base 内所有表 + 跨表关联边（links / subtable 正向字段）。
// 不拉每表全部字段，只取 ERD 所需最小子集（id/name/字段数 + 关联方向）。
// 避免前端为每张表 N 次 useFields 的 hooks 数量爆炸。

bases.get("/:baseId/erd", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanView(c, baseId);

  const tables = await prisma.table.findMany({
    where: { baseId, deletedAt: null },
    select: { id: true, name: true },
  });
  const tableIds = tables.map((t) => t.id);

  // 每表的「链接型字段」：links + subtable 正向（去重：正向和反向配对只画一条边）
  const linkFields = await prisma.field.findMany({
    where: {
      tableId: { in: tableIds },
      deletedAt: null,
      type: { in: ["links", "subtable"] },
      isReverse: false,
      relatedTableId: { not: null },
    },
    select: {
      id: true,
      name: true,
      type: true,
      tableId: true,
      relatedTableId: true,
      relationKind: true,
    },
  });

  // 每表总字段数（含已删？仅活跃）
  const fieldCounts = await prisma.field.groupBy({
    by: ["tableId"],
    where: { tableId: { in: tableIds }, deletedAt: null },
    _count: { _all: true },
  });
  const countMap = new Map(fieldCounts.map((r) => [r.tableId, r._count._all]));

  // 每表出度（关联条数）
  const outMap = new Map<string, number>();
  for (const f of linkFields) {
    if (!f.relatedTableId) continue;
    outMap.set(f.tableId, (outMap.get(f.tableId) ?? 0) + 1);
  }

  return c.json({
    tables: tables.map((t) => ({
      id: t.id,
      name: t.name,
      fieldCount: countMap.get(t.id) ?? 0,
      outDegree: outMap.get(t.id) ?? 0,
    })),
    edges: linkFields
      .filter((f) => f.relatedTableId && tableIds.includes(f.relatedTableId))
      .map((f) => ({
        fromTableId: f.tableId,
        toTableId: f.relatedTableId!,
        fromFieldId: f.id,
        fromFieldName: f.name,
        fieldType: f.type,
        relationKind: f.relationKind,
      })),
  });
});

// ============ 成员管理 ============

bases.get("/:baseId/members", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanView(c, baseId);
  const members = await prisma.member.findMany({
    where: { baseId },
    include: { user: { select: { email: true, displayName: true } } },
    orderBy: { joinedAt: "asc" },
  });
  return c.json({
    members: members.map((m) => ({
      id: m.id,
      baseId: m.baseId,
      userId: m.userId,
      email: m.user.email,
      displayName: m.user.displayName,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
    })),
  });
});

bases.post("/:baseId/members", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanManageBase(c, baseId);
  const parsed = inviteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user) return c.json({ error: "该邮箱尚未注册" }, 404);

  const existing = await prisma.member.findUnique({ where: { baseId_userId: { baseId, userId: user.id } } });
  if (existing) return c.json({ error: "该用户已是成员" }, 409);

  const member = await prisma.member.create({
    data: { baseId, userId: user.id, role: parsed.data.role },
  });
  return c.json({
    member: {
      id: member.id,
      baseId,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: member.role,
      joinedAt: member.joinedAt.toISOString(),
    },
  }, 201);
});

bases.patch("/:baseId/members/:memberId", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanManageBase(c, baseId);
  const parsed = updateMemberSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  const member = await prisma.member.findUnique({ where: { id: c.req.param("memberId") } });
  if (!member || member.baseId !== baseId) throw new HttpError(404, "成员不存在");
  if (member.role === "owner") throw new HttpError(400, "不能修改所有者的角色");

  const updated = await prisma.member.update({
    where: { id: member.id },
    data: { role: parsed.data.role },
  });
  return c.json({ member: { id: updated.id, role: updated.role } });
});

bases.delete("/:baseId/members/:memberId", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanManageBase(c, baseId);
  const member = await prisma.member.findUnique({ where: { id: c.req.param("memberId") } });
  if (!member || member.baseId !== baseId) throw new HttpError(404, "成员不存在");
  if (member.role === "owner") throw new HttpError(400, "不能移除所有者");
  await prisma.member.delete({ where: { id: member.id } });
  return c.json({ ok: true });
});

// ============ 分享链接 ============

bases.get("/:baseId/share", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanManageBase(c, baseId);
  const links = await prisma.shareLink.findMany({ where: { baseId }, orderBy: { createdAt: "desc" } });
  return c.json({
    links: links.map((l) => ({
      id: l.id,
      baseId: l.baseId,
      token: l.token,
      role: l.role,
      createdAt: l.createdAt.toISOString(),
      expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null,
      url: `/share/${l.token}`,
    })),
  });
});

bases.post("/:baseId/share", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanManageBase(c, baseId);
  const parsed = shareSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

  // 分享 token 是「持有即准入」的凭证，必须用加密安全随机（Math.random 可预测）。
  const token = randomBytes(24).toString("base64url");
  const link = await prisma.shareLink.create({
    data: {
      baseId,
      token,
      role: parsed.data.role,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    },
  });
  return c.json({
    link: {
      id: link.id,
      baseId,
      token: link.token,
      role: link.role,
      createdAt: link.createdAt.toISOString(),
      expiresAt: link.expiresAt ? link.expiresAt.toISOString() : null,
      url: `/share/${link.token}`,
    },
  }, 201);
});

bases.delete("/:baseId/share/:linkId", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanManageBase(c, baseId);
  await prisma.shareLink.deleteMany({ where: { id: c.req.param("linkId"), baseId } });
  return c.json({ ok: true });
});

// ============ 通过分享 token 加入 ============

bases.post("/join/:token", async (c) => {
  const userId = await requireUserId(c);
  const token = c.req.param("token");
  const link = await prisma.shareLink.findUnique({ where: { token } });
  if (!link) throw new HttpError(404, "分享链接无效");
  if (link.expiresAt && link.expiresAt < new Date()) throw new HttpError(410, "分享链接已过期");

  const existing = await prisma.member.findUnique({
    where: { baseId_userId: { baseId: link.baseId, userId } },
  });
  if (existing) {
    return c.json({ baseId: link.baseId, role: existing.role, alreadyMember: true });
  }

  await prisma.member.create({ data: { baseId: link.baseId, userId, role: link.role } });
  return c.json({ baseId: link.baseId, role: link.role, alreadyMember: false }, 201);
});

