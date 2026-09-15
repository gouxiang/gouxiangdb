// apps/api/src/routes/kb/acl.ts
// 单文档独立权限（kb_doc_acls）：列出 / 授予或撤销（role=null 撤销）。
// M4/S5 commit ① 从 routes/kb.ts 机械拆出，零行为变化。

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../../db.js";
import { requireUserId, errorResponse, HttpError } from "../../guards.js";
import { RANK, kbRoleOf, requireDocAccess } from "./shared.js";

export const aclRoutes = new Hono();

aclRoutes.get("/docs/:docId/acl", async (c) => {
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

aclRoutes.put("/docs/:docId/acl", async (c) => {
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
