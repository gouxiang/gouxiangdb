// apps/api/src/routes/kb/sharing.ts
// 单文档外链分享开关/令牌 + 内部成员权限批量调整。
// M4/S5 commit ① 从 routes/kb.ts 机械拆出，零行为变化。

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx } from "../../db.js";
import { requireUserId, errorResponse, HttpError } from "../../guards.js";
import { syncKbMemberTx } from "../../domain/authz/projection.js";
import { genShareToken, kbRoleOf, requireDocAccess } from "./shared.js";

export const sharingRoutes = new Hono();

sharingRoutes.get("/docs/:docId/share", async (c) => {
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

sharingRoutes.post("/docs/:docId/share", async (c) => {
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
sharingRoutes.post("/docs/:docId/share/internal", async (c) => {
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
      select: { id: true, userId: true, role: true },
    });
    // "仅可见"=viewer，"可编辑"=editor；commenter 归并（viewer 侧）
    const desired = target === "editor" ? "editor" : "viewer";
    // M4/S5：原 withWriteBatch 无 tx 句柄，无法挂投影。改为交互事务逐条 update + 同事务投影，
    // 成员角色变更与 auth_policies 投影共生死（裁决 9）。
    const changed = members.filter((m) => m.role !== desired);
    await withWriteTx("kb.internalShare", async (tx) => {
      for (const m of changed) {
        await tx.kbMember.update({
          where: { kbId_userId: { kbId: doc.kbId, userId: m.userId } },
          data: { role: desired },
        });
        await syncKbMemberTx(tx, { oldRowId: m.id, kbId: doc.kbId, userId: m.userId, role: desired });
      }
    });
    return c.json({ ok: true, role: desired });
  } catch (e) {
    return errorResponse(c, e);
  }
});
