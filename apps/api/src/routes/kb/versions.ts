// apps/api/src/routes/kb/versions.ts
// 文档版本：列表 / 单版本取 / 手动存版本 / 回滚（回滚前自动备份）。
// M4/S5 commit ① 从 routes/kb.ts 机械拆出，零行为变化。

import { Hono } from "hono";
import { z } from "zod";
import { prisma, withWriteTx } from "../../db.js";
import { requireUserId, errorResponse, HttpError } from "../../guards.js";
import { buildSearchText, createManualVersion } from "../../domain/kb.js";
import { enqueueChangeEventTx } from "../../domain/search/outbox.js";
import { requireDocAccess } from "./shared.js";

export const versionsRoutes = new Hono();

versionsRoutes.get("/docs/:docId/versions", async (c) => {
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

versionsRoutes.get("/docs/:docId/versions/:vid", async (c) => {
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

versionsRoutes.post("/docs/:docId/versions", async (c) => {
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

versionsRoutes.post("/docs/:docId/rollback/:vid", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const { doc } = await requireDocAccess(userId, docId, true);
    const v = await prisma.kbDocVersion.findUnique({ where: { id: c.req.param("vid") } });
    if (!v || v.docId !== docId) throw new HttpError(404, "版本不存在");
    // 回滚前把当前状态存一个自动快照，避免误操作丢失
    await createManualVersion(docId, userId, `回滚前自动备份（回滚到 v${v.version}）`);
    // M5/S1：原裸 kbDoc.update 收紧进事务以承载 outbox；回滚改正文/标题属内容变更，发 upsert。
    await withWriteTx("doc.rollback", async (tx) => {
      await tx.kbDoc.update({
        where: { id: docId },
        data: {
          title: v.title,
          content: v.content,
          searchText: buildSearchText(doc.kind, v.content),
          updatedBy: userId,
        },
      });
      await enqueueChangeEventTx(tx, {
        entityType: doc.kind === "canvas" ? "canvas" : "doc",
        entityId: docId, op: "upsert", version: BigInt(Date.now()),
      });
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});
