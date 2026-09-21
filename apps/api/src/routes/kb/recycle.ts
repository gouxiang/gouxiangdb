// apps/api/src/routes/kb/recycle.ts
// 回收站：列出已删文档 + 物理永久删（owner-only；先清版本/ACL，再 purgeDocNodeTx 清节点）。
// M4/S5 commit ① 从 routes/kb.ts 机械拆出，零行为变化。

import { Hono } from "hono";
import { prisma, withWriteTx } from "../../db.js";
import { requireUserId, errorResponse, HttpError } from "../../guards.js";
import { syncNavFromEntitiesTx, purgeDocNodeTx } from "../../domain/nav/sync.js";
import { removeDocAclProjectionsTx } from "../../domain/authz/projection.js";
import { enqueueChangeEventTx } from "../../domain/search/outbox.js";
import { requireKb } from "./shared.js";

export const recycleRoutes = new Hono();

recycleRoutes.delete("/docs/:docId/permanent", async (c) => {
  try {
    const userId = await requireUserId(c);
    const docId = c.req.param("docId");
    const doc = await prisma.kbDoc.findUnique({ where: { id: docId } });
    if (!doc) throw new HttpError(404, "文档不存在");
    // 先过库身份（非成员 403 / 库不存在或已软删 404），再提级 owner-only：成员资格与角色提级
    // 分两步，不把"是不是这个库的人"隐含在"角色等不等于 owner"里。与同文件 GET /:kbId/trash
    // 同源（都走 requireKb），顺带纳入 requireKb 的 shadow 对拍，且库缺失时回 404 而非 403。
    const { role } = await requireKb(userId, doc.kbId);
    if (role !== "owner") throw new HttpError(403, "只有知识库所有者可彻底删除");
    // M3/S3 #13d-永久删：顺序关键（nav_nodes 自引用 ON DELETE RESTRICT）——先删版本/ACL/实体，
    // 再按期望集对齐，把仍活的孤儿子文档（实体 parentId 悬空）节点改挂 kb、解除对被删节点的
    // 父子引用，最后 purgeDocNodeTx 清自身 shortcut + 删节点（doc 永久删按内容所有者语义主动
    // 清引用，不像 table/view 那样 409）。
    await withWriteTx("doc.purge", async (tx) => {
      await tx.kbDocVersion.deleteMany({ where: { docId } });
      await tx.kbDocAcl.deleteMany({ where: { docId } });
      // M4/S5 同事务清该 doc/canvas 节点全部 legacy:acl 投影（多条 ACL 共指一节点）。
      await removeDocAclProjectionsTx(tx, { docId, kind: doc.kind });
      await tx.kbDoc.delete({ where: { id: docId } });
      // M5/S1：物理删登记 delete 墓碑（事件无 FK，实体消失后仍可消费清派生检索行；
      // 软删时若已有未消费 delete 则被同 op 吸收，已 done 则补一条）。
      await enqueueChangeEventTx(tx, {
        entityType: doc.kind === "canvas" ? "canvas" : "doc",
        entityId: docId, op: "delete", version: BigInt(Date.now()),
      });
      await syncNavFromEntitiesTx(tx);
      await purgeDocNodeTx(tx, docId);
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});

recycleRoutes.get("/:kbId/trash", async (c) => {
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
