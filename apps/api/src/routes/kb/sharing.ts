// apps/api/src/routes/kb/sharing.ts
// 单文档外链分享开关/令牌 + 内部成员权限批量调整。
// M4/S5 commit ① 从 routes/kb.ts 机械拆出，零行为变化。

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireUserId, errorResponse } from "../../guards.js";
import { readShareEnabled } from "../../domain/authz/libraryVisibility.js";
import { assertSharerCanGrantDocEdit, resolveDocShareCaps } from "../../domain/share/shareCaps.js";
import { genShareToken, requireDocAccess } from "./shared.js";

export const sharingRoutes = new Hono();

sharingRoutes.get("/docs/:docId/share", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc, access } = await requireDocAccess(userId, docId);
    // 能否外发取决于所在知识库的「允许分享」开关（库级；知识库没有表这一级）。
    const shareAllowed = await readShareEnabled("kb", doc.kbId);
    // 档位现算：分享人（开分享的人）被降权后，可编辑链接当场回落只读。
    const caps = await resolveDocShareCaps(doc.shareRole, doc.kbId, doc.shareCreatedBy);
    return c.json({
      share: {
        canManage: access.canManage,
        shareAllowed,
        shareEnabled: doc.shareEnabled,
        shareToken: doc.shareToken,
        shareRole: doc.shareRole,
        shareIncludeChildren: doc.shareIncludeChildren,
        shareUrl: doc.shareToken ? `/s/${doc.shareToken}` : null,
        // 文档正文的匿名写仍关闭，故 canEdit 恒 false；mode 才是宿主分享的真实档位，
        // 它决定文档内【嵌入的数据表预览】能不能写（见 publicEmbed.ts）。
        canEdit: false,
        mode: caps.mode,
        requestedMode: caps.requestedMode,
        degraded: caps.degraded,
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

    // 硬约束：可编辑档位只发给本人此刻就有内容编辑权的人（前端置灰不算防线）。
    // 知识库没有"表"，文档与画布共用 content 这一档对象的四枚动作。
    const nextRole = parsed.data.shareRole ?? doc.shareRole;
    if (parsed.data.shareEnabled && nextRole === "editor") {
      await assertSharerCanGrantDocEdit(userId, doc.kbId);
    }

    const updated = await prisma.kbDoc.update({
      where: { id: doc.id },
      data: {
        shareEnabled: parsed.data.shareEnabled,
        shareToken: token,
        ...(parsed.data.shareRole ? { shareRole: parsed.data.shareRole } : {}),
        ...(parsed.data.shareIncludeChildren !== undefined ? { shareIncludeChildren: parsed.data.shareIncludeChildren } : {}),
        // 记录"这次是谁开的分享"：可编辑链接的动态降级按他当前的库权限重算。
        // 关闭分享即清空——下次再开时重新绑定，不保留过期主体。
        shareCreatedBy: parsed.data.shareEnabled ? userId : null,
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
        canEdit: false,
        mode: updated.shareEnabled && updated.shareRole === "editor" ? "edit" : "view",
      },
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});
