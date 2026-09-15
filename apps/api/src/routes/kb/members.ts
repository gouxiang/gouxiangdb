// apps/api/src/routes/kb/members.ts
// 知识库成员路由：列出 / 加成员（owner-only）/ 移除成员（owner-only + 防反踢业务保护）。
// M4/S5 commit ① 从 routes/kb.ts 机械拆出，零行为变化；路由路径与挂在同一 kb 子 app 时完全一致。

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx } from "../../db.js";
import { requireUserId, errorResponse, HttpError } from "../../guards.js";
import {
  syncKbMemberTx,
  removeLegacyProjectionTx,
  LEGACY_REASONS,
} from "../../domain/authz/projection.js";
import { requireKb, shadowKbAction } from "./shared.js";

export const membersRoutes = new Hono();

membersRoutes.get("/:kbId/members", async (c) => {
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

membersRoutes.post("/:kbId/members", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    const { role } = await requireKb(userId, kbId);
    if (role !== "owner") {
      await shadowKbAction("kb.member.add", userId, kbId, "manage_share", false);
      throw new HttpError(403, "只有所有者可管理成员");
    }
    await shadowKbAction("kb.member.add", userId, kbId, "manage_share", true);
    const schema = z.object({ email: z.string().email(), role: z.enum(["editor", "commenter", "viewer"]) });
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      // 提示里说明 owner 不可授予，防止把整库控制权误交他人后被反锁。
      return c.json({ error: "参数不合法（需有效邮箱；角色仅支持 editor/commenter/viewer，owner 不可授予）" }, 400);
    }
    const target = await prisma.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } });
    if (!target) return c.json({ error: "该用户尚未注册，无法添加" }, 404);
    const m = await withWriteTx("kb.member.upsert", async (tx) => {
      const row = await tx.kbMember.upsert({
        where: { kbId_userId: { kbId, userId: target.id } },
        update: { role: parsed.data.role },
        create: { kbId, userId: target.id, role: parsed.data.role },
      });
      // M4/S5 加/改成员同事务投影（精确 SET：降级也收窄）。
      await syncKbMemberTx(tx, {
        oldRowId: row.id, kbId, userId: target.id, role: row.role,
      });
      return row;
    });
    return c.json({ member: { userId: m.userId, role: m.role } }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

membersRoutes.delete("/:kbId/members/:memberUserId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    const target = c.req.param("memberUserId");
    const { role } = await requireKb(userId, kbId);
    if (role !== "owner") {
      await shadowKbAction("kb.member.remove", userId, kbId, "manage_share", false);
      throw new HttpError(403, "只有所有者可移除成员");
    }
    await shadowKbAction("kb.member.remove", userId, kbId, "manage_share", true);
    // 保护：owner 成员不可被移除（防止被加为 owner 的成员反踢原所有者）；
    // 操作者也不可移除自己（防止误操作导致自己失去访问权）。
    if (target === userId) throw new HttpError(400, "不能移除自己；如需转让知识库请联系所有者");
    const targetMember = await prisma.kbMember.findUnique({
      where: { kbId_userId: { kbId, userId: target } },
      select: { id: true, role: true },
    });
    if (!targetMember) throw new HttpError(404, "该成员不存在");
    if (targetMember.role === "owner") throw new HttpError(403, "不能移除知识库所有者");
    await withWriteTx("kb.member.remove", async (tx) => {
      await tx.kbMember.deleteMany({ where: { kbId, userId: target } });
      // M4/S5 同事务删该成员 legacy 投影（确定性 id 由 kb_members 旧行 id 派生）。
      await removeLegacyProjectionTx(tx, LEGACY_REASONS.kbMember, targetMember.id);
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});
