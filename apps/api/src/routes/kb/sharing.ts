// apps/api/src/routes/kb/sharing.ts
// 单文档外链分享开关/令牌 + 内部成员权限批量调整。
// M4/S5 commit ① 从 routes/kb.ts 机械拆出，零行为变化。

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireUserId, errorResponse } from "../../guards.js";
import { readShareEnabled } from "../../domain/authz/libraryVisibility.js";
import { genShareToken, requireDocAccess } from "./shared.js";

export const sharingRoutes = new Hono();

sharingRoutes.get("/docs/:docId/share", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc, access } = await requireDocAccess(userId, docId);
    // 外部人只读：分享链接不提供任何写能力（见 public.ts），故 canEdit 恒 false。
    // 能否外发取决于所在知识库的「允许分享」开关（库级；知识库没有表这一级）。
    const shareAllowed = await readShareEnabled("kb", doc.kbId);
    return c.json({
      share: {
        canManage: access.canManage,
        shareAllowed,
        shareEnabled: doc.shareEnabled,
        shareToken: doc.shareToken,
        shareRole: doc.shareRole,
        shareIncludeChildren: doc.shareIncludeChildren,
        shareUrl: doc.shareToken ? `/s/${doc.shareToken}` : null,
      },
      // 内部成员能不能改由所在知识库的角色配置决定；这里只回一个汇总开关给弹窗。
      internal: { membersCanEdit: access.canManage },
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
