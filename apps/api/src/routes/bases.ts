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
  requireCanDeleteBase,
  requireCanToggleShare,
  permissionsOf,
  displayRole,
  permit,
  HttpError,
} from "../guards.js";
import { permissionsForRole, type Role, type ViewConfig } from "@gx/shared-types";
import { makeOptions } from "../domain/fieldService.js";
import { syncNavFromEntitiesTx, softDeleteSubtreeTx } from "../domain/nav/sync.js";
import { nodeId } from "../domain/nav/backfill.js";
import { syncBaseMemberTx } from "../domain/authz/projection.js";
import { assertCanCreateLibrary } from "../domain/org/createLibraryGuard.js";
import { resolveManyAccess, visibleLibraryIds } from "../domain/authz/libraryPolicy.js";
import { libraryVisibility, setShareEnabled } from "../domain/authz/libraryVisibility.js";
import { seedAdminScopeTx } from "../domain/authz/libraryScopeSeed.js";
import { entityIconSchema, entityIconColorSchema } from "../validators/entity-icon.js";

export const bases = new Hono();

// Base.iconColor 列 NOT NULL（schema.prisma @default("#378ADD")）：null 语义 = 恢复默认色，
// 不能直写 NULL（SQLite 会拒绝），故 PATCH 时映射为该系统默认色；缺省则不写这一列。
const BASE_DEFAULT_ICON_COLOR = "#378ADD";

const createSchema = z.object({
  name: z.string().min(1).max(80),
  iconColor: z.string().optional(),
  // 自定义图标：白名单内图标名；null = 清除回默认（新建一般不带，与 iconColor 对齐开放）。
  icon: entityIconSchema,
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  // 自定义颜色：#RRGGBB | null（恢复默认色）| 缺省（不改动）。
  iconColor: entityIconColorSchema,
  icon: entityIconSchema,
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
  // 权限核心模型：能看见哪些库由【角色的库视野】决定，不再看 members 表。
  // 超级管理员/管理员返回 all=true（进得去所有库），其余按勾中的库过滤。
  const { all, ids } = await visibleLibraryIds(userId, "base");
  const rows = await prisma.base.findMany({
    where: { deletedAt: null, ...(all ? {} : { id: { in: ids } }) },
    include: { _count: { select: { tables: { where: { deletedAt: null } } } } },
    orderBy: { createdAt: "asc" },
  });
  const accessMap = await resolveManyAccess(userId, "base", rows.map((r) => r.id));
  const out = rows.map((b) => {
    const access = accessMap.get(b.id)!;
    return {
      id: b.id,
      name: b.name,
      iconColor: b.iconColor,
      icon: b.icon,
      createdAt: b.createdAt.toISOString(),
      createdBy: b.createdBy,
      // 展示档位，不承载授权语义（真判据是下面的 permissions/access 派生）。
      role: displayRole(access),
      permissions: permit(access),
      shareEnabled: b.shareEnabled === 1,
      tableCount: b._count.tables,
    };
  });
  return c.json({ bases: out });
});

// ============ 创建 ============

bases.post("/", async (c) => {
  const userId = await requireUserId(c);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法", details: parsed.error.issues }, 400);

  // M6 权限门：建库不是登录即有的能力，须由管理员按角色授予 create_library（写库之前拦）。
  await assertCanCreateLibrary(userId);

  // 名字写库前 trim：纯空格名 400（zod min(1) 拦不住 "   "）。
  const name = parsed.data.name.trim();
  if (name === "") return c.json({ error: "数据库名不能为空" }, 400);

  // M3/S3 #1：建 base 多步写（base+owner 成员+starter 表/字段/视图）收紧进单事务，
  // 同事务同步 nav_nodes（base + table + view 节点）。nav 写失败整体回滚（裁决 9）。
  const base = await withWriteTx("base.create", async (tx) => {
    // 全局重名校验在写事务内、用 tx 做（deletedAt:null）。
    const dup = await tx.base.findFirst({ where: { name, deletedAt: null }, select: { id: true } });
    if (dup) throw new HttpError(409, `数据库名「${name}」已存在`);
    const b = await tx.base.create({
      data: {
        name,
        iconColor: parsed.data.iconColor ?? "#378ADD",
        icon: parsed.data.icon ?? null,
        createdBy: userId,
      },
    });
    // M4/S5 同事务投影 owner 到 base 节点 user 策略行（auth_policies 无 FK，先于 sync 建节点亦安全）。
    // 注意：members 行在权限核心模型（二）之后【不再参与放行】，仅作导航旧表的投影源与台账。
    const ownerMember = await tx.member.create({ data: { baseId: b.id, userId, role: "owner" } });
    await syncBaseMemberTx(tx, { oldRowId: ownerMember.id, baseId: b.id, userId, role: "owner" });
    // 取消库主后，库权限一律走「角色 × 库」：建库同事务给超级管理员/管理员补视野行，
    // 否则管理员建完库连一张表都加不上（管理权只来自 role_library_scope.canManage）。
    await seedAdminScopeTx(tx, "base", b.id, userId);
    await createStarterTableTx(tx, b.id, userId);
    await syncNavFromEntitiesTx(tx);
    // 第三批导航重构后一级导航直接读 bases/knowledge_bases，不再读 menu_items，
    // 故这里不再补 shortcut（原 ensureEntityShortcutTx 调用已连同该函数一并摘除）。
    return b;
  });

  return c.json({
    base: {
      id: base.id,
      name: base.name,
      iconColor: base.iconColor,
      icon: base.icon,
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
      icon: base.icon,
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

  // 改名：trim 后写库，纯空格 400；不传 name（只改 icon 等）不触发。
  let nextName: string | undefined;
  if (parsed.data.name !== undefined) {
    nextName = parsed.data.name.trim();
    if (nextName === "") throw new HttpError(400, "数据库名不能为空");
  }

  // M3/S3 #2：改名同事务同步节点 name（iconColor / icon 都不影响节点——实体图标走读取时解析，
  // 不同步进 nav_nodes，故 syncNavFromEntitiesTx 语义不动）。
  const base = await withWriteTx("base.rename", async (tx) => {
    // 全局重名校验在写事务内、用 tx 做并排除自己；只在带 name 时校验。
    if (nextName !== undefined) {
      const dup = await tx.base.findFirst({
        where: { name: nextName, deletedAt: null, id: { not: baseId } },
        select: { id: true },
      });
      if (dup) throw new HttpError(409, `数据库名「${nextName}」已存在`);
    }
    const b = await tx.base.update({
      where: { id: baseId },
      // 三态映射：缺省 → 不写列（保持原值）；#RRGGBB → 原样；null → 系统默认色。
      data: {
        name: nextName,
        iconColor:
          parsed.data.iconColor === undefined
            ? undefined
            : parsed.data.iconColor ?? BASE_DEFAULT_ICON_COLOR,
        icon: parsed.data.icon,
      },
    });
    await syncNavFromEntitiesTx(tx);
    return b;
  });
  return c.json({
    base: { id: base.id, name: base.name, iconColor: base.iconColor, icon: base.icon },
  });
});

bases.delete("/:baseId", async (c) => {
  const baseId = c.req.param("baseId");
  // 硬规则：删除库只有超级管理员。能管这个库的人也删不掉。
  await requireCanDeleteBase(c, baseId);
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

// ============ 成员可见性（只读） ============
//
// 逐库逐人的成员名册已下线：权限只按角色配，所以这里能回答的只有
// "哪些角色覆盖到这个库、覆盖到多少人"。POST/PATCH/DELETE 全部移除——
// 留着它们就等于留一条"改一行数据就能绕过角色体系"的旁路。
// 要改谁能进来：去通讯录改这个人的角色，或改角色的库视野。

bases.get("/:baseId/members", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanView(c, baseId);
  return c.json(await libraryVisibility("base", baseId));
});

// ============ 允许分享开关（库级） ============
// 只有对该库有管理权的角色 + 超级管理员 + 管理员能开。开了才允许成员外发本库数据。

bases.patch("/:baseId/share-enabled", async (c) => {
  const baseId = c.req.param("baseId");
  await requireCanToggleShare(c, baseId);
  const schema = z.object({ enabled: z.boolean() });
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "参数不合法" }, 400);
  const enabled = await setShareEnabled("base", baseId, parsed.data.enabled);
  return c.json({ shareEnabled: enabled });
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
  const { userId } = await requireCanManageBase(c, baseId);
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
      // 存量库级链接沿用旧语义（objectType 默认 base、mode 默认 view），只补分享人：
      // 库级链接不提供记录写入面，但补上主体后未来若开放可编辑，动态降级才有判定依据。
      createdBy: userId,
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
