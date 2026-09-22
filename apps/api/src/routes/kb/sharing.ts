// apps/api/src/routes/kb/sharing.ts
// 单文档外链分享开关/令牌 + 内部成员权限批量调整。
// M4/S5 commit ① 从 routes/kb.ts 机械拆出，零行为变化。
//
// 建/管分享的第三道闸（与数据表侧 tableShares.assertCanShareTable 同口径）：
// 进得来这个库（requireDocAccess）不等于能外发它——还必须有 access.canShare
// （= canManage ∪ 角色的 canShare 位）。本端点会把 shareToken / 分享链接原样回给调用方，
// 拿到链接等于拿到"对外发布这篇文档"的能力，故查与改两道都必须过这道闸。

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireUserId, errorResponse, HttpError } from "../../guards.js";
import { readShareEnabled } from "../../domain/authz/libraryVisibility.js";
import { assertSharerCanGrantDocEdit, canSharerGrantDocEdit, resolveDocShareCaps } from "../../domain/share/shareCaps.js";
import { genShareToken, requireDocAccess } from "./shared.js";

export const sharingRoutes = new Hono();

sharingRoutes.get("/docs/:docId/share", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc, access } = await requireDocAccess(userId, docId);
    if (!access.canShare) {
      throw new HttpError(403, "你没有这个库的分享权限：需要角色被授予「可分享」或对该库有管理权");
    }
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
        // 文档正文的匿名写已按「可编辑链接」口径放开（PUT /api/public/s/:token/doc/:docId/content）。
        // canEdit 由分享人【此刻】的内容改权现算：他被降权/移出后当场回落只读。
        // 未开启分享时没有链接可走，一律 false（不因历史档位残留而误报可写）。
        canEdit: doc.shareEnabled ? caps.canEdit : false,
        mode: caps.mode,
        requestedMode: caps.requestedMode,
        degraded: caps.degraded,
        // 本人此刻能否开「可编辑」——供弹窗把该选项置灰。后端 POST 仍会再判一次，
        // 这里是同一次判定（canSharerGrantDocEdit / assertSharerCanGrantDocEdit 共用），不会两套口径。
        canGrantEdit: await canSharerGrantDocEdit(userId, doc.kbId),
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
    const { doc, access } = await requireDocAccess(userId, docId, true);
    if (!access.canShare) {
      throw new HttpError(403, "你没有这个库的分享权限：需要角色被授予「可分享」或对该库有管理权");
    }
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
    // 落库后按新档位重算（与 GET 同一判定 resolveDocShareCaps，不会两套口径）：
    // 刚把分享人绑成当前用户（shareCreatedBy=userId），故这里算出的就是「本次开关后的真实能力」。
    const caps = await resolveDocShareCaps(updated.shareRole, updated.kbId, updated.shareCreatedBy);
    return c.json({
      share: {
        shareEnabled: updated.shareEnabled,
        shareToken: updated.shareToken,
        shareRole: updated.shareRole,
        shareIncludeChildren: updated.shareIncludeChildren,
        shareUrl: updated.shareToken ? `/s/${updated.shareToken}` : null,
        canEdit: updated.shareEnabled ? caps.canEdit : false,
        mode: updated.shareEnabled ? caps.mode : "view",
        requestedMode: caps.requestedMode,
        degraded: caps.degraded,
        canGrantEdit: await canSharerGrantDocEdit(userId, doc.kbId),
      },
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});
