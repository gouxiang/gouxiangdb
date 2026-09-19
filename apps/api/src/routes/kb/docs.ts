// apps/api/src/routes/kb/docs.ts
// 知识库内容路由：内容列表/新建、单内容读取/重命名/正文保存（乐观锁）/移动/软删/找回。
// M4/S5 commit ① 从 routes/kb.ts 机械拆出，零行为变化。
// 分享（share*）、永久删（permanent）、版本（versions*）、ACL（acl）在各自子模块。

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx } from "../../db.js";
import { VersionConflictError, changeEntityOfKind, saveDocContentTx } from "../../domain/kbDocWrite.js";
import { requireUserId, errorResponse, HttpError } from "../../guards.js";
import { buildSearchText } from "../../domain/kb.js";
import {
  syncNavFromEntitiesTx,
  softDeleteSingleNodeTx,
} from "../../domain/nav/sync.js";
import {
  RANK,
  isDescendant,
  requireDocAccess,
  requireKb,
  kbRoleOf,
  shadowKbAction,
} from "./shared.js";
import { enqueueChangeEventTx } from "../../domain/search/outbox.js";
import type { ChangeEntityType } from "../../domain/search/outbox.js";
import { entityIconSchema, entityIconColorSchema } from "../../validators/entity-icon.js";

/** kb_docs.kind 到检索实体类型（doc/canvas 分别建索引）。 */

export const docsRoutes = new Hono();

// ============ 内容列表 / 新建 ============

docsRoutes.get("/:kbId/docs", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    await requireKb(userId, kbId);
    const kind = c.req.query("kind"); // "doc" | "canvas" | 空
    const q = (c.req.query("q") ?? "").trim();

    const docs = await prisma.kbDoc.findMany({
      where: {
        kbId,
        deletedAt: null,
        ...(kind === "doc" || kind === "canvas" ? { kind } : {}),
        ...(q ? { searchText: { contains: q } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true, kind: true, title: true, parentId: true, createdAt: true, updatedAt: true,
        createdBy: true, updatedBy: true,
        // 自定义图标（doc 与 canvas 共用 kb_docs，按 kind 由前端取默认）。
        icon: true, iconColor: true,
      },
    });
    return c.json({ docs });
  } catch (e) {
    return errorResponse(c, e);
  }
});

docsRoutes.post("/:kbId/docs", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    const { role } = await requireKb(userId, kbId);
    const canCreate = RANK[role]! >= RANK["editor"]!;
    if (!canCreate) {
      await shadowKbAction("kb.doc.create", userId, kbId, "c", false);
      throw new HttpError(403, "当前角色无权创建内容");
    }
    await shadowKbAction("kb.doc.create", userId, kbId, "c", true);
    const schema = z.object({
      kind: z.enum(["doc", "canvas"]),
      title: z.string().max(120).optional(),
      parentId: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "类型不合法（doc 或 canvas）" }, 400);
    const title = parsed.data.title?.trim() || (parsed.data.kind === "canvas" ? "未命名画布" : "未命名文档");
    // 父文档校验：仅文档参与级联；父级必须同库且未删除
    let parentId: string | null = null;
    if (parsed.data.kind === "doc" && parsed.data.parentId) {
      const parent = await prisma.kbDoc.findFirst({
        where: { id: parsed.data.parentId, kbId, deletedAt: null, kind: "doc" },
        select: { id: true },
      });
      if (!parent) throw new HttpError(400, "父文档不存在或已被删除");
      parentId = parent.id;
    }
    // M3/S3 #13a：建 doc/canvas + 首版本收紧进单事务；同事务 upsert nav 节点
    // （doc 父=parent doc 节点或 kb 节点；canvas 父=kb 节点，由期望集统一算）。
    const doc = await withWriteTx("doc.create", async (tx) => {
      const d = await tx.kbDoc.create({
        data: {
          kbId,
          kind: parsed.data.kind,
          title,
          content: parsed.data.kind === "canvas" ? "[]" : "",
          searchText: "",
          createdBy: userId,
          updatedBy: userId,
          ...(parentId ? { parentId } : {}),
        },
      });
      await tx.kbDocVersion.create({
        data: { docId: d.id, version: 1, label: "创建", title: d.title, content: d.content, createdBy: userId },
      });
      // M5/S1：文档/画布建，同事务登记 upsert（version 取新内容版本 0，worker 抽当前内容）。
      await enqueueChangeEventTx(tx, {
        entityType: changeEntityOfKind(d.kind), entityId: d.id, op: "upsert", version: BigInt(d.contentVersion),
      });
      await syncNavFromEntitiesTx(tx);
      return d;
    });
    return c.json({ doc }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ============ 单内容：读取 / 重命名 / 保存 ============

docsRoutes.get("/docs/:docId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc, role, canEdit } = await requireDocAccess(userId, docId);
    return c.json({
      doc: {
        id: doc.id, kbId: doc.kbId, kind: doc.kind, title: doc.title, content: doc.content,
        parentId: doc.parentId, contentVersion: doc.contentVersion,
        icon: doc.icon, iconColor: doc.iconColor,
        createdAt: doc.createdAt, updatedAt: doc.updatedAt, createdBy: doc.createdBy, updatedBy: doc.updatedBy,
        myRole: role, canEdit,
      },
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

docsRoutes.patch("/docs/:docId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc } = await requireDocAccess(userId, docId, true);
    const schema = z.object({
      title: z.string().min(1).max(120).optional(),
      // 自定义图标（白名单）与图标颜色（#RRGGBB）；null = 清除回默认，缺省 = 不改动。
      // icon / iconColor 不进 nav_nodes（实体图标走读取时解析），也不影响检索正文，
      // 故只有改名才触发 outbox upsert 与 nav 同步。
      icon: entityIconSchema,
      iconColor: entityIconColorSchema,
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法（标题 / icon / iconColor）" }, 400);
    const { title, icon, iconColor } = parsed.data;
    const iconTouched = icon !== undefined || iconColor !== undefined;
    if (title !== undefined || iconTouched) {
      // M3/S3 #13b：改名收紧进事务同步节点 name；图标变更同事务但不触发 nav 同步。
      await withWriteTx("doc.rename", async (tx) => {
        await tx.kbDoc.update({
          where: { id: doc.id },
          data: {
            ...(title !== undefined ? { title: title.trim() } : {}),
            ...(icon !== undefined ? { icon } : {}),
            ...(iconColor !== undefined ? { iconColor } : {}),
            updatedBy: userId,
          },
        });
        if (title !== undefined) {
          // M5/S1：改名改标题文本（检索内容），发 upsert；version 用提交时刻（doc 无版本递增）。
          await enqueueChangeEventTx(tx, {
            entityType: changeEntityOfKind(doc.kind), entityId: doc.id, op: "upsert", version: BigInt(Date.now()),
          });
          await syncNavFromEntitiesTx(tx);
        }
      });
    }
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

docsRoutes.put("/docs/:docId/content", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc } = await requireDocAccess(userId, docId, true);
    const schema = z.object({
      // U-10：内部写也加上限（10MB，画布 JSON 元素极多时的容忍值）
      content: z.string().max(10_000_000, "内容超过 10MB 上限"),
      title: z.string().max(120).optional(),
      // S-1 乐观锁：客户端携带读取时的版本号，条件更新防 lost update
      baseVersion: z.number().int().min(0).optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "内容不合法" }, 400);
    const content = parsed.data.content;
    const searchText = buildSearchText(doc.kind, content);
    const title = parsed.data.title?.trim();
    // M3/S3（baseline 偏差补接）：内容保存会更新 updatedAt（节点 ord 依赖 updatedAt desc），
    // 附带 title 时还要改节点 name；故内容更新+版本快照+nav 同步整体进单事务。
    // 乐观锁不匹配抛 VersionConflictError -> 事务回滚 + catch 内回现网特殊 409 信封。
    // M6/S4：事务体已移入 domain/kbDocWrite.ts（纯移动 + 显式传参）。
    const result = await withWriteTx("doc.content.save", (tx) => saveDocContentTx(tx, {
      docId: doc.id, kind: doc.kind, currentVersion: doc.contentVersion,
      content, searchText, userId, title, baseVersion: parsed.data.baseVersion,
    }));
    return c.json({ ok: true, snapshotted: result.snapshotted, savedAt: new Date().toISOString(), contentVersion: result.contentVersion });
  } catch (e) {
    if (e instanceof VersionConflictError) {
      return c.json({ error: e.message, code: "VERSION_CONFLICT", currentVersion: e.currentVersion }, 409);
    }
    return errorResponse(c, e);
  }
});

// ============ 多文档级联：移动（改 parentId） ============

docsRoutes.post("/docs/:docId/move", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc } = await requireDocAccess(userId, docId, true);
    const schema = z.object({ parentId: z.string().nullable() });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法" }, 400);
    const targetParent = parsed.data.parentId;

    // 仅文档参与级联树
    if (doc.kind !== "doc") throw new HttpError(400, "画布不支持层级嵌套");

    if (targetParent === null) {
      // M3/S3 #13c：改 parentId 收紧进事务；节点改挂 kb + 整棵子树 path 重算。
      await withWriteTx("doc.move", async (tx) => {
        await tx.kbDoc.update({ where: { id: doc.id }, data: { parentId: null, updatedBy: userId } });
        await syncNavFromEntitiesTx(tx);
      });
      return c.json({ ok: true, parentId: null });
    }

    // 父级必须同库、未删除、是文档
    const parent = await prisma.kbDoc.findFirst({
      where: { id: targetParent, kbId: doc.kbId, deletedAt: null, kind: "doc" },
      select: { id: true },
    });
    if (!parent) throw new HttpError(400, "目标父文档不存在或已被删除");
    if (parent.id === doc.id) throw new HttpError(400, "无法移动：不能将文档放到它自己下面");
    // 防循环：不能把文档放到它自己的后代下
    if (await isDescendant(doc.id, parent.id)) {
      throw new HttpError(400, "无法移动：不能将文档放到它自己的子级中");
    }
    await withWriteTx("doc.move", async (tx) => {
      await tx.kbDoc.update({ where: { id: doc.id }, data: { parentId: parent.id, updatedBy: userId } });
      // 节点改挂父 doc，其下子文档节点作为后代随期望集对齐 + path 全量重算（子树平移）。
      await syncNavFromEntitiesTx(tx);
    });
    return c.json({ ok: true, parentId: parent.id });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ============ 软删 / 找回 ============

docsRoutes.delete("/docs/:docId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc } = await requireDocAccess(userId, docId, true);
    // M3/S3 #13d-软删：doc/canvas 不级联子内容（实体层只软删单条），nav 只软删自身节点；
    // 随后按期望集对齐（被删父 doc 的活子文档节点父回退 kb + 全量重算 ord/path）。
    const kind = doc.kind === "canvas" ? "canvas" : "doc";
    await withWriteTx("doc.softDelete", async (tx) => {
      await tx.kbDoc.update({ where: { id: docId }, data: { deletedAt: new Date(), deletedBy: userId } });
      await softDeleteSingleNodeTx(tx, kind, docId);
      // M5/S1：软删登记 delete（worker 清派生检索行）。
      await enqueueChangeEventTx(tx, {
        entityType: changeEntityOfKind(doc.kind), entityId: docId, op: "delete", version: BigInt(Date.now()),
      });
      await syncNavFromEntitiesTx(tx);
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

docsRoutes.post("/docs/:docId/restore", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const doc = await prisma.kbDoc.findUnique({ where: { id: docId } });
    if (!doc) throw new HttpError(404, "文档不存在");
    // 找回需要知识库成员编辑权限
    await requireKb(userId, doc.kbId);
    const role = await kbRoleOf(userId, doc.kbId);
    if (!role || RANK[role]! < RANK["editor"]!) throw new HttpError(403, "无权找回");
    // M3/S3 #13d-恢复：复活实体 + 复活软删节点（期望集对齐含原地复活、重挂父、重算 ord/path）。
    await withWriteTx("doc.restore", async (tx) => {
      await tx.kbDoc.update({ where: { id: docId }, data: { deletedAt: null, deletedBy: null } });
      // M5/S1：恢复登记 upsert（恢复不改 contentVersion，worker 按现存内容重建索引）。
      await enqueueChangeEventTx(tx, {
        entityType: changeEntityOfKind(doc.kind), entityId: docId, op: "upsert", version: BigInt(doc.contentVersion),
      });
      await syncNavFromEntitiesTx(tx);
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});
