// apps/api/src/routes/kb.ts
// 知识库路由：容器（KnowledgeBase）+ 内容（KbDoc：文档/画布）+ 版本 + 回收站 + 权限 + 全文检索。
// 完全独立于 bases/tables/fields/records 路由，不改动数据表侧任何逻辑。

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx, withWriteBatch } from "../db.js";
import { HttpError, requireUserId, errorResponse } from "../guards.js";
import {
  buildSearchText,
  maybeAutoSnapshotTx,
  createManualVersion,
} from "../domain/kb.js";
import {
  syncNavFromEntitiesTx,
  softDeleteSubtreeTx,
  softDeleteSingleNodeTx,
  purgeDocNodeTx,
} from "../domain/nav/sync.js";
import { nodeId } from "../domain/nav/backfill.js";

export const kb = new Hono();

type Role = "owner" | "editor" | "commenter" | "viewer";
const ROLES: Role[] = ["owner", "editor", "commenter", "viewer"];

// ============ 权限辅助 ============

async function kbRoleOf(userId: string, kbId: string): Promise<Role | null> {
  const m = await prisma.kbMember.findUnique({
    where: { kbId_userId: { kbId, userId } },
    select: { role: true },
  });
  return (m?.role as Role) ?? null;
}

async function docAclRoleOf(userId: string, docId: string): Promise<Role | null> {
  const a = await prisma.kbDocAcl.findUnique({
    where: { docId_userId: { docId, userId } },
    select: { role: true },
  });
  return (a?.role as Role) ?? null;
}

const RANK: Record<string, number> = { owner: 4, editor: 3, commenter: 2, viewer: 1 };

/** 乐观锁冲突：沿用现网特殊信封 {error, code:"VERSION_CONFLICT", currentVersion} + 409。 */
class VersionConflictError extends HttpError {
  constructor(public currentVersion: number | null) {
    super(409, "文档已被他人修改，请刷新后重试");
  }
}

async function requireKb(userId: string, kbId: string): Promise<{ role: Role }> {
  const kb = await prisma.knowledgeBase.findFirst({ where: { id: kbId, deletedAt: null } });
  if (!kb) throw new HttpError(404, "知识库不存在");
  const role = await kbRoleOf(userId, kbId);
  if (!role) throw new HttpError(403, "无权访问该知识库");
  return { role };
}

/** 内容访问：知识库成员 或 单文档 ACL 授权 */
async function requireDocAccess(userId: string, docId: string, needEdit = false) {
  const doc = await prisma.kbDoc.findFirst({ where: { id: docId, deletedAt: null } });
  if (!doc) throw new HttpError(404, "文档不存在或已删除");
  const kbRole = await kbRoleOf(userId, doc.kbId);
  const aclRole = await docAclRoleOf(userId, docId);
  const effective =
    kbRole && aclRole ? (RANK[kbRole]! >= RANK[aclRole]! ? kbRole : aclRole) : (kbRole ?? aclRole);
  if (!effective) throw new HttpError(403, "无权访问该内容");
  const canEdit = RANK[effective]! >= RANK["editor"]!;
  if (needEdit && !canEdit) throw new HttpError(403, "当前角色无权编辑");
  return { doc, role: effective as Role, canEdit };
}

/** 生成分享令牌：URL-safe 随机串 */
function genShareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 判断 maybeDesc 是否为 ancestorId 的后代（沿 parentId 向上走，含深度上限防环） */
async function isDescendant(ancestorId: string, maybeDescId: string): Promise<boolean> {
  if (ancestorId === maybeDescId) return true;
  let cur: string | null = maybeDescId;
  const seen = new Set<string>();
  for (let i = 0; i < 200 && cur; i++) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) break; // 数据异常自环保护
    seen.add(cur);
    const row: { parentId: string | null } | null = await prisma.kbDoc.findUnique({
      where: { id: cur },
      select: { parentId: true },
    });
    cur = row?.parentId ?? null;
  }
  return false;
}

// ============ 知识库容器 ============

kb.get("/", async (c) => {
  try {
    const userId = await requireUserId(c);
    const memberships = await prisma.kbMember.findMany({
      where: { userId, kb: { deletedAt: null } },
      include: {
        kb: {
          include: {
            _count: { select: { docs: { where: { deletedAt: null } } } },
          },
        },
      },
      orderBy: { joinedAt: "desc" },
    });
    const kbs = memberships
      .filter((m) => m.kb)
      .map((m) => ({
        id: m.kb!.id,
        name: m.kb!.name,
        iconColor: m.kb!.iconColor,
        role: m.role,
        docCount: m.kb!._count.docs,
        createdAt: m.kb!.createdAt,
        updatedAt: m.kb!.updatedAt,
      }));
    return c.json({ knowledgeBases: kbs });
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

    // M3/S3 #11：建 kb（含 owner 成员）收紧进事务，同事务 upsert kb 节点。
    const created = await withWriteTx("kb.create", async (tx) => {
      const k = await tx.knowledgeBase.create({
        data: {
          name: parsed.data.name,
          iconColor: parsed.data.iconColor ?? "#0F6E56",
          createdBy: userId,
          members: { create: { userId, role: "owner" } },
        },
      });
      await syncNavFromEntitiesTx(tx);
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
    return c.json({ knowledgeBase: { id: full.id, name: full.name, iconColor: full.iconColor, role, createdAt: full.createdAt } });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.patch("/:kbId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    const { role } = await requireKb(userId, kbId);
    if (role !== "owner") throw new HttpError(403, "只有所有者可修改知识库");
    const schema = z.object({ name: z.string().min(1).max(80).optional(), iconColor: z.string().optional() });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法" }, 400);
    // M3/S3 #12a：改名收紧进事务同步 kb 节点 name（iconColor 不进树，也一并同事务）。
    const updated = await withWriteTx("kb.rename", async (tx) => {
      const u = await tx.knowledgeBase.update({
        where: { id: kbId },
        data: { name: parsed.data.name, iconColor: parsed.data.iconColor },
      });
      if (parsed.data.name !== undefined) await syncNavFromEntitiesTx(tx);
      return u;
    });
    return c.json({ knowledgeBase: { id: updated.id, name: updated.name, iconColor: updated.iconColor } });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.delete("/:kbId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    const { role } = await requireKb(userId, kbId);
    if (role !== "owner") throw new HttpError(403, "只有所有者可删除知识库");
    const now = new Date();
    // M3/S3 #12b：kb 软删 + 级联 docs 收紧进单事务；nav 整棵子树（kb/doc/canvas）软删。
    // kb 无恢复端点（裁决 6），子树节点随实体一并软删、保留行；如需找回由管理员 reconcile 兜底。
    await withWriteTx("kb.softDelete", async (tx) => {
      await tx.knowledgeBase.update({ where: { id: kbId }, data: { deletedAt: now } });
      await tx.kbDoc.updateMany({ where: { kbId }, data: { deletedAt: now, deletedBy: userId } });
      await softDeleteSubtreeTx(tx, nodeId("kb", kbId));
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ============ 知识库成员 ============

kb.get("/:kbId/members", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    await requireKb(userId, kbId);
    const members = await prisma.kbMember.findMany({
      where: { kbId },
      include: { user: { select: { id: true, email: true, displayName: true } } },
      orderBy: { joinedAt: "asc" },
    });
    return c.json({
      members: members.map((m) => ({
        id: m.id,
        userId: m.userId,
        email: m.user.email,
        displayName: m.user.displayName,
        role: m.role,
      })),
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.post("/:kbId/members", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    const { role } = await requireKb(userId, kbId);
    if (role !== "owner") throw new HttpError(403, "只有所有者可管理成员");
    const schema = z.object({ email: z.string().email(), role: z.enum(["editor", "commenter", "viewer"]) });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      // 提示里说明 owner 不可授予，防止把整库控制权误交他人后被反锁。
      return c.json({ error: "参数不合法（需有效邮箱；角色仅支持 editor/commenter/viewer，owner 不可授予）" }, 400);
    }
    const target = await prisma.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } });
    if (!target) return c.json({ error: "该用户尚未注册，无法添加" }, 404);
    const m = await prisma.kbMember.upsert({
      where: { kbId_userId: { kbId, userId: target.id } },
      update: { role: parsed.data.role },
      create: { kbId, userId: target.id, role: parsed.data.role },
    });
    return c.json({ member: { userId: m.userId, role: m.role } }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.delete("/:kbId/members/:memberUserId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    const target = c.req.param("memberUserId");
    const { role } = await requireKb(userId, kbId);
    if (role !== "owner") throw new HttpError(403, "只有所有者可移除成员");
    // 保护：owner 成员不可被移除（防止被加为 owner 的成员反踢原所有者）；
    // 操作者也不可移除自己（防止误操作导致自己失去访问权）。
    if (target === userId) throw new HttpError(400, "不能移除自己；如需转让知识库请联系所有者");
    const targetMember = await prisma.kbMember.findUnique({
      where: { kbId_userId: { kbId, userId: target } },
      select: { role: true },
    });
    if (!targetMember) throw new HttpError(404, "该成员不存在");
    if (targetMember.role === "owner") throw new HttpError(403, "不能移除知识库所有者");
    await prisma.kbMember.deleteMany({ where: { kbId, userId: target } });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ============ 内容列表 / 新建 / 全文检索 ============

kb.get("/:kbId/docs", async (c) => {
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
      },
    });
    return c.json({ docs });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.post("/:kbId/docs", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    const { role } = await requireKb(userId, kbId);
    if (RANK[role]! < RANK["editor"]!) throw new HttpError(403, "当前角色无权创建内容");
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
      await syncNavFromEntitiesTx(tx);
      return d;
    });
    return c.json({ doc }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ============ 单内容：读取 / 重命名 / 保存 / 删除 ============

kb.get("/docs/:docId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc, role, canEdit } = await requireDocAccess(userId, docId);
    return c.json({
      doc: {
        id: doc.id, kbId: doc.kbId, kind: doc.kind, title: doc.title, content: doc.content,
        parentId: doc.parentId, contentVersion: doc.contentVersion,
        createdAt: doc.createdAt, updatedAt: doc.updatedAt, createdBy: doc.createdBy, updatedBy: doc.updatedBy,
        myRole: role, canEdit,
      },
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.patch("/docs/:docId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc } = await requireDocAccess(userId, docId, true);
    const schema = z.object({ title: z.string().min(1).max(120).optional() });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "标题不合法" }, 400);
    if (parsed.data.title !== undefined) {
      // M3/S3 #13b：改名收紧进事务同步节点 name。
      await withWriteTx("doc.rename", async (tx) => {
        await tx.kbDoc.update({
          where: { id: doc.id },
          data: { title: parsed.data.title!.trim(), updatedBy: userId },
        });
        await syncNavFromEntitiesTx(tx);
      });
    }
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.put("/docs/:docId/content", async (c) => {
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
    const result = await withWriteTx("doc.content.save", async (tx) => {
      const data = {
        content,
        searchText,
        updatedBy: userId,
        contentVersion: { increment: 1 as const },
        ...(title ? { title } : {}),
      };
      if (parsed.data.baseVersion !== undefined) {
        // 条件更新：版本不匹配说明他人已保存，抛错回滚，由外层回 409 冲突信封
        const res = await tx.kbDoc.updateMany({
          where: { id: doc.id, contentVersion: parsed.data.baseVersion },
          data,
        });
        if (res.count === 0) {
          const cur = await tx.kbDoc.findUnique({ where: { id: doc.id }, select: { contentVersion: true } });
          throw new VersionConflictError(cur?.contentVersion ?? null);
        }
      } else {
        // 旧客户端（未携带版本）：保持 last-write-wins，但版本号照常递增
        await tx.kbDoc.update({ where: { id: doc.id }, data });
      }
      const snapshotted = await maybeAutoSnapshotTx(tx, doc.id, userId);
      const next = await tx.kbDoc.findUnique({ where: { id: doc.id }, select: { contentVersion: true } });
      await syncNavFromEntitiesTx(tx);
      return { snapshotted, contentVersion: next?.contentVersion ?? null };
    });
    return c.json({ ok: true, snapshotted: result.snapshotted, savedAt: new Date().toISOString(), contentVersion: result.contentVersion });
  } catch (e) {
    if (e instanceof VersionConflictError) {
      return c.json({ error: e.message, code: "VERSION_CONFLICT", currentVersion: e.currentVersion }, 409);
    }
    return errorResponse(c, e);
  }
});

// ============ 多文档级联：移动（改 parentId） ============

kb.post("/docs/:docId/move", async (c) => {
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

// ============ 分享：外链开关 / 内部权限 ============

kb.get("/docs/:docId/share", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc, canEdit } = await requireDocAccess(userId, docId);
    // 团队内部当前角色分布（供弹窗展示"内部成员"权限概览）
    const members = await prisma.kbMember.findMany({
      where: { kbId: doc.kbId },
      select: { role: true },
    });
    const hasEditor = members.some((m) => m.role === "owner" || m.role === "editor");
    return c.json({
      share: {
        canManage: canEdit,
        shareEnabled: doc.shareEnabled,
        shareToken: doc.shareToken,
        shareRole: doc.shareRole,
        shareIncludeChildren: doc.shareIncludeChildren,
        shareUrl: doc.shareToken ? `/s/${doc.shareToken}` : null,
      },
      internal: { membersCanEdit: hasEditor, memberCount: members.length },
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.post("/docs/:docId/share", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc } = await requireDocAccess(userId, docId, true);
    const schema = z.object({
      shareEnabled: z.boolean(),
      shareRole: z.enum(["viewer", "editor"]).optional(),
      shareIncludeChildren: z.boolean().optional(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法" }, 400);

    let token = doc.shareToken;
    if (parsed.data.shareEnabled) {
      if (!token) token = genShareToken();
    } else {
      token = null; // 关闭即吊销
    }
    const updated = await prisma.kbDoc.update({
      where: { id: doc.id },
      data: {
        shareEnabled: parsed.data.shareEnabled,
        shareToken: token,
        ...(parsed.data.shareRole ? { shareRole: parsed.data.shareRole } : {}),
        ...(parsed.data.shareIncludeChildren !== undefined ? { shareIncludeChildren: parsed.data.shareIncludeChildren } : {}),
        updatedBy: userId,
      },
    });
    return c.json({
      share: {
        shareEnabled: updated.shareEnabled,
        shareToken: updated.shareToken,
        shareRole: updated.shareRole,
        shareIncludeChildren: updated.shareIncludeChildren,
        shareUrl: updated.shareToken ? `/s/${updated.shareToken}` : null,
      },
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// 内部成员权限批量调整：把当前知识库成员统一为 viewer 或 editor（不降低 owner）
kb.post("/docs/:docId/share/internal", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc } = await requireDocAccess(userId, docId, true);
    const schema = z.object({ role: z.enum(["viewer", "editor"]) });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法" }, 400);
    const target = parsed.data.role;
    // 仅知识库 owner 可批量改团队角色；否则无权
    const kbRole = await kbRoleOf(userId, doc.kbId);
    if (kbRole !== "owner") throw new HttpError(403, "只有知识库所有者可调整团队权限");

    const members = await prisma.kbMember.findMany({
      where: { kbId: doc.kbId, role: { not: "owner" } },
      select: { userId: true, role: true },
    });
    // "仅可见"=viewer，"可编辑"=editor；commenter 归并（viewer 侧）
    const desired = target === "editor" ? "editor" : "viewer";
    await withWriteBatch(
      "kb.internalShare",
      members
        .filter((m) => m.role !== desired)
        .map((m) =>
          prisma.kbMember.update({ where: { kbId_userId: { kbId: doc.kbId, userId: m.userId } }, data: { role: desired } }),
        ),
    );
    return c.json({ ok: true, role: desired });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.delete("/docs/:docId", async (c) => {
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
      await syncNavFromEntitiesTx(tx);
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.post("/docs/:docId/restore", async (c) => {
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
      await syncNavFromEntitiesTx(tx);
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.delete("/docs/:docId/permanent", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const doc = await prisma.kbDoc.findUnique({ where: { id: docId } });
    if (!doc) throw new HttpError(404, "文档不存在");
    const role = await kbRoleOf(userId, doc.kbId);
    if (role !== "owner") throw new HttpError(403, "只有知识库所有者可彻底删除");
    // M3/S3 #13d-永久删：顺序关键（nav_nodes 自引用 ON DELETE RESTRICT）——先删版本/ACL/实体，
    // 再按期望集对齐，把仍活的孤儿子文档（实体 parentId 悬空）节点改挂 kb、解除对被删节点的
    // 父子引用，最后 purgeDocNodeTx 清自身 shortcut + 删节点（doc 永久删按内容所有者语义主动
    // 清引用，不像 table/view 那样 409）。
    await withWriteTx("doc.purge", async (tx) => {
      await tx.kbDocVersion.deleteMany({ where: { docId } });
      await tx.kbDocAcl.deleteMany({ where: { docId } });
      await tx.kbDoc.delete({ where: { id: docId } });
      await syncNavFromEntitiesTx(tx);
      await purgeDocNodeTx(tx, docId);
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ============ 回收站 ============

kb.get("/:kbId/trash", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    await requireKb(userId, kbId);
    const docs = await prisma.kbDoc.findMany({
      where: { kbId, deletedAt: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, kind: true, title: true, deletedAt: true, deletedBy: true, updatedAt: true },
    });
    return c.json({ docs });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ============ 版本 ============

kb.get("/docs/:docId/versions", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    await requireDocAccess(userId, docId);
    const versions = await prisma.kbDocVersion.findMany({
      where: { docId },
      orderBy: { version: "desc" },
      select: { id: true, version: true, label: true, title: true, createdBy: true, createdAt: true },
    });
    return c.json({ versions });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.get("/docs/:docId/versions/:vid", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    await requireDocAccess(userId, docId);
    const v = await prisma.kbDocVersion.findUnique({ where: { id: c.req.param("vid") } });
    if (!v || v.docId !== docId) throw new HttpError(404, "版本不存在");
    return c.json({ version: v });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.post("/docs/:docId/versions", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    await requireDocAccess(userId, docId, true);
    const schema = z.object({ label: z.string().max(120).optional() });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "备注不合法" }, 400);
    const { version } = await createManualVersion(docId, userId, parsed.data.label ?? "");
    return c.json({ version }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.post("/docs/:docId/rollback/:vid", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc } = await requireDocAccess(userId, docId, true);
    const v = await prisma.kbDocVersion.findUnique({ where: { id: c.req.param("vid") } });
    if (!v || v.docId !== docId) throw new HttpError(404, "版本不存在");
    // 回滚前把当前状态存一个自动快照，避免误操作丢失
    await createManualVersion(docId, userId, `回滚前自动备份（回滚到 v${v.version}）`);
    await prisma.kbDoc.update({
      where: { id: docId },
      data: {
        title: v.title,
        content: v.content,
        searchText: buildSearchText(doc.kind, v.content),
        updatedBy: userId,
      },
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// ============ 单文档独立权限（ACL） ============

kb.get("/docs/:docId/acl", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    await requireDocAccess(userId, docId);
    const acls = await prisma.kbDocAcl.findMany({
      where: { docId },
      include: { user: { select: { email: true, displayName: true } } },
    });
    return c.json({
      acls: acls.map((a) => ({ userId: a.userId, email: a.user.email, displayName: a.user.displayName, role: a.role })),
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

kb.put("/docs/:docId/acl", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc } = await requireDocAccess(userId, docId, true);
    // 仅知识库 owner/editor 可授予文档权限
    const role = await kbRoleOf(userId, doc.kbId);
    if (!role || RANK[role]! < RANK["editor"]!) throw new HttpError(403, "无权设置文档权限");
    const schema = z.object({
      email: z.string().email(),
      role: z.enum(["editor", "commenter", "viewer"]).nullable(),
    });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法" }, 400);
    const target = await prisma.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } });
    if (!target) return c.json({ error: "该用户尚未注册" }, 404);
    if (!parsed.data.role) {
      await prisma.kbDocAcl.deleteMany({ where: { docId, userId: target.id } });
      return c.json({ ok: true, revoked: true });
    }
    await prisma.kbDocAcl.upsert({
      where: { docId_userId: { docId, userId: target.id } },
      update: { role: parsed.data.role },
      create: { docId, userId: target.id, role: parsed.data.role },
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

void ROLES;
