// apps/api/src/routes/kb/index.ts
// 知识库路由入口：容器（KnowledgeBase）CRUD + 挂载成员/内容/分享/回收站/版本/ACL 子路由。
// 完全独立于 bases/tables/fields/records 路由，不改动数据表侧任何逻辑。
//
// M4/S5 commit ① 从单文件 routes/kb.ts（897 行）按资源分包（零行为变化）：
//   index    容器 5 端点（list/create/get/rename/soft-delete）+ 子路由装配
//   members  成员只读 1 端点；docs 内容 9 端点；sharing 分享 3 端点；
//   versions 版本 4 端点；recycle 回收站 + 永久删 2 端点；
//   shared   守卫/角色/ACL/shadow 对拍缝（无路由）。
// URL/请求/响应/状态码与拆分前逐字节一致；app.ts 改 import "./routes/kb/index.js"
// （Bundler 解析下带 .js 后缀不会回退目录索引，显式指向本 index，同 v1 路由写法）。

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx } from "../../db.js";
import { requireUserId, errorResponse, HttpError } from "../../guards.js";
import {
  syncNavFromEntitiesTx,
  softDeleteSubtreeTx,
} from "../../domain/nav/sync.js";
import { nodeId } from "../../domain/nav/backfill.js";
import { enqueueChangeEventsTx } from "../../domain/search/outbox.js";
import {
  entityIconSchema,
  entityIconColorSchema,
} from "../../validators/entity-icon.js";
import { requireKb, shadowKbAction } from "./shared.js";
import { resolveKbAccess, resolveManyAccess, visibleLibraryIds } from "../../domain/authz/libraryPolicy.js";
import { libraryVisibility, setShareEnabled } from "../../domain/authz/libraryVisibility.js";
import { seedAdminScopeTx } from "../../domain/authz/libraryScopeSeed.js";
import { assertCanCreateLibrary } from "../../domain/org/createLibraryGuard.js";
import { membersRoutes } from "./members.js";
import { docsRoutes } from "./docs.js";
import { sharingRoutes } from "./sharing.js";
import { versionsRoutes } from "./versions.js";
import { recycleRoutes } from "./recycle.js";

export const kb = new Hono();

// KnowledgeBase.iconColor 列 NOT NULL（schema.prisma @default("#0F6E56")）：null 语义 = 恢复默认色，
// 不能直写 NULL（SQLite 会拒绝），故 PATCH 时映射为该系统默认色；缺省则不写这一列。
const KB_DEFAULT_ICON_COLOR = "#0F6E56";

// ============ 知识库容器 ============

kb.get("/", async (c) => {
  try {
    const userId = await requireUserId(c);
    // 与 bases 列表同源：能看见哪些知识库由【角色的库视野】决定，不再看 kb_members。
    const { all, ids } = await visibleLibraryIds(userId, "kb");
    const rows = await prisma.knowledgeBase.findMany({
      where: { deletedAt: null, ...(all ? {} : { id: { in: ids } }) },
      include: { _count: { select: { docs: { where: { deletedAt: null } } } } },
      orderBy: { createdAt: "desc" },
    });
    const accessMap = await resolveManyAccess(userId, "kb", rows.map((r) => r.id));
    const knowledgeBases = rows.map((k) => {
      const access = accessMap.get(k.id)!;
      return {
        id: k.id,
        name: k.name,
        iconColor: k.iconColor,
        icon: k.icon,
        role: access.canManage ? "owner" : "viewer",
        canManage: access.canManage,
        shareEnabled: k.shareEnabled === 1,
        docCount: k._count.docs,
        createdAt: k.createdAt,
        updatedAt: k.updatedAt,
      };
    });
    return c.json({ knowledgeBases });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.post("/", async (c) => {
  try {
    const userId = await requireUserId(c);
    const schema = z.object({
      name: z.string().min(1).max(80),
      iconColor: z.string().optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "名称不合法" }, 400);

    // M6 权限门：与建库同源，建知识库须由管理员按角色授予 create_library（写库之前拦）。
    // 抛出的 HttpError(403) 由下方 catch 的 errorResponse 映射为 {error, code} + 403。
    await assertCanCreateLibrary(userId);

    // 名字写库前 trim：纯空格名 400（zod min(1) 拦不住 "   "）。
    const name = parsed.data.name.trim();
    if (name === "") return c.json({ error: "知识库名不能为空" }, 400);

    // M3/S3 #11：建 kb（含 owner 成员）收紧进事务，同事务 upsert kb 节点。
    const created = await withWriteTx("kb.create", async (tx) => {
      // 全局重名校验在写事务内、用 tx 做（deletedAt:null）。
      const dup = await tx.knowledgeBase.findFirst({ where: { name, deletedAt: null }, select: { id: true } });
      if (dup) throw new HttpError(409, `知识库名「${name}」已存在`);
      const k = await tx.knowledgeBase.create({
        data: {
          name,
          iconColor: parsed.data.iconColor ?? "#0F6E56",
          createdBy: userId,
          members: { create: { userId, role: "owner" } },
        },
      });
      // 取消库主后同建库：给超级管理员/管理员补「角色 × 知识库」视野行（管理权唯一来源）。
      await seedAdminScopeTx(tx, "kb", k.id);
      await syncNavFromEntitiesTx(tx);
      // 与建库同理：一级导航已改为直接读 knowledge_bases，不再靠 menu_items shortcut，
      // 自动写入随「导航编排」一并下线（ensureEntityShortcutTx 已从 domain/nav/menu.ts 摘除）。
      return k;
    });
    return c.json({ knowledgeBase: { id: created.id, name: created.name, iconColor: created.iconColor, role: "owner" } }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.get("/:kbId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    const { role } = await requireKb(userId, kbId);
    const full = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
    if (!full) throw new HttpError(404, "知识库不存在");
    return c.json({
      knowledgeBase: {
        id: full.id,
        name: full.name,
        iconColor: full.iconColor,
        icon: full.icon,
        role,
        createdAt: full.createdAt,
      },
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.patch("/:kbId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    const { role } = await requireKb(userId, kbId);
    const canManageShare = role === "owner";
    if (!canManageShare) {
      await shadowKbAction("kb.rename", userId, kbId, "manage_share", false);
      throw new HttpError(403, "只有所有者可修改知识库");
    }
    await shadowKbAction("kb.rename", userId, kbId, "manage_share", true);
    const schema = z.object({
      name: z.string().min(1).max(80).optional(),
      // 自定义颜色：#RRGGBB | null（恢复默认色）| 缺省（不改动）。
      iconColor: entityIconColorSchema,
      icon: entityIconSchema,
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

    // 改名：trim 后写库，纯空格 400；不传 name（只改 icon 等）不触发。
    let nextName: string | undefined;
    if (parsed.data.name !== undefined) {
      nextName = parsed.data.name.trim();
      if (nextName === "") throw new HttpError(400, "知识库名不能为空");
    }

    // M3/S3 #12a：改名收紧进事务同步 kb 节点 name（iconColor / icon 不进树，也一并同事务）。
    const updated = await withWriteTx("kb.rename", async (tx) => {
      // 全局重名校验在写事务内、用 tx 做并排除自己；只在带 name 时校验。
      if (nextName !== undefined) {
        const dup = await tx.knowledgeBase.findFirst({
          where: { name: nextName, deletedAt: null, id: { not: kbId } },
          select: { id: true },
        });
        if (dup) throw new HttpError(409, `知识库名「${nextName}」已存在`);
      }
      const u = await tx.knowledgeBase.update({
        where: { id: kbId },
        // 三态映射：缺省 → 不写列（保持原值）；#RRGGBB → 原样；null → 系统默认色。
        data: {
          name: nextName,
          iconColor:
            parsed.data.iconColor === undefined
              ? undefined
              : parsed.data.iconColor ?? KB_DEFAULT_ICON_COLOR,
          icon: parsed.data.icon,
        },
      });
      if (nextName !== undefined) await syncNavFromEntitiesTx(tx);
      return u;
    });
    return c.json({
      knowledgeBase: {
        id: updated.id,
        name: updated.name,
        iconColor: updated.iconColor,
        icon: updated.icon,
      },
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.delete("/:kbId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    // 硬规则：删除知识库只有超级管理员。对本库有管理权的角色也删不掉。
    await requireKb(userId, kbId);
    const access = await resolveKbAccess(userId, kbId);
    if (!access.canDeleteLibrary) {
      await shadowKbAction("kb.delete", userId, kbId, "manage_share", false);
      throw new HttpError(403, "只有超级管理员可以删除知识库");
    }
    await shadowKbAction("kb.delete", userId, kbId, "manage_share", true);
    const now = new Date();
    // M3/S3 #12b：kb 软删 + 级联 docs 收紧进单事务；nav 整棵子树（kb/doc/canvas）软删。
    // kb 无恢复端点（裁决 6），子树节点随实体一并软删、保留行；如需找回由管理员 reconcile 兜底。
    await withWriteTx("kb.softDelete", async (tx) => {
      await tx.knowledgeBase.update({ where: { id: kbId }, data: { deletedAt: now } });
      // M5/S1：级联软删前收集活内容（doc/canvas），逐条按实体类型登记 delete。
      const liveDocs = await tx.kbDoc.findMany({
        where: { kbId, deletedAt: null }, select: { id: true, kind: true },
      });
      await tx.kbDoc.updateMany({ where: { kbId }, data: { deletedAt: now, deletedBy: userId } });
      await softDeleteSubtreeTx(tx, nodeId("kb", kbId));
      if (liveDocs.length > 0) {
        const kbDeleteVersion = BigInt(now.getTime());
        await enqueueChangeEventsTx(tx, liveDocs.map((d) => ({
          entityType: d.kind === "canvas" ? "canvas" as const : "doc" as const,
          entityId: d.id, op: "delete" as const, version: kbDeleteVersion,
        })));
      }
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// 库级「允许分享」开关：只有对本库有管理权的角色 + 超级管理员 + 管理员能开。
kb.patch("/:kbId/share-enabled", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    await requireKb(userId, kbId);
    const access = await resolveKbAccess(userId, kbId);
    if (!access.canToggleShare) throw new HttpError(403, "只有对本库有管理权限的角色、超级管理员或管理员可开关分享");
    const schema = z.object({ enabled: z.boolean() });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法" }, 400);
    return c.json({ shareEnabled: await setShareEnabled("kb", kbId, parsed.data.enabled) });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ============ 子路由装配（同挂 kb 子 app，路径不变） ============
// 注册覆盖 monolith 原全部端点；Hono 静态段优先于参数段（/docs/* 先于 /:kbId），与拆分前同解析。
kb.route("/", membersRoutes);
kb.route("/", docsRoutes);
kb.route("/", sharingRoutes);
kb.route("/", versionsRoutes);
kb.route("/", recycleRoutes);
