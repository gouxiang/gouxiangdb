// apps/api/src/routes/tableShares.ts
// 数据表分享链接的创建 / 列表 / 吊销（挂载在 /api/tables 下）。
//
//   GET    /api/tables/:tableId/share              本表当前全部分享链接（含实时档位）
//   POST   /api/tables/:tableId/share              建链接 { mode: "view"|"edit", viewId?, expiresAt? }
//   DELETE /api/tables/:tableId/share/:linkId      吊销
//
// 谁能建：看得见这张表 + 该表两级分享开关都开（库级 shareEnabled && 表级 shareEnabled）
//        + 本人对这个库有分享权（access.canShare = canManage ∪ 角色的 canShare 位）。
//          两级总闸说的是"这个库/这张表允不允许被外发"，canShare 说的是"你这个人能不能发"，
//          两道闸各管一半，缺一个都不能建——只看总闸的话，库里每个只读成员都能随手发链接。
// 谁能建【可编辑】：额外要求【分享人本人】此刻对该表有改权（assertSharerCanGrantEdit）。
//   前端会把可编辑选项置灰，但置灰不是防线——后端这里必须自己判一次，否则抓包即可绕过。
// 建出来之后：可编辑不是一锤子买卖，每次访问按分享人当前权限重算（shareCaps.ts）。

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, errorResponse, requireUserId } from "../guards.js";
import type { ObjectShareLinkDTO, ShareMode } from "@gx/shared-types";
import { resolveBaseAccessByTable, tableAccessOf } from "../domain/authz/libraryPolicy.js";
import { tableShareAllowed } from "../domain/authz/libraryVisibility.js";
import { assertSharerCanGrantEdit, resolveTableShareCaps } from "../domain/share/shareCaps.js";
import { genShareToken } from "./kb/shared.js";
import { audit } from "../audit/emit.js";
import type { ShareLinkRow } from "../domain/share/shareLinkLookup.js";

export const tableShares = new Hono();

const createSchema = z.object({
  mode: z.enum(["view", "edit"]).default("view"),
  viewId: z.string().min(1).optional(),
  expiresAt: z.string().datetime().optional(),
});

/** 建/看/吊销链接的三道前置门：表可见 + 两级开关都开 + 本人有分享权。 */
async function assertCanShareTable(userId: string, tableId: string) {
  const table = await prisma.table.findFirst({ where: { id: tableId, deletedAt: null }, select: { id: true } });
  if (!table) throw new HttpError(404, "数据表不存在");
  const access = await resolveBaseAccessByTable(userId, tableId);
  if (!access || !access.visible) throw new HttpError(403, "无权访问该数据表");
  if (!(await tableShareAllowed(tableId))) {
    throw new HttpError(403, "该数据表未开启分享（需库级与表级「允许分享」开关都打开）");
  }
  // 第三道闸：总闸开了不代表人人都能发。能管这个库的自然能发，其余要有角色显式的 canShare 位。
  if (!access.canShare) {
    throw new HttpError(403, "你没有这个库的分享权限：需要角色被授予「可分享」或对该库有管理权");
  }
  return access;
}

async function toDTO(row: ShareLinkRow): Promise<ObjectShareLinkDTO> {
  // 列表里的档位同样是现算的：管理员打开设置页就应看到"这条已经降级了"。
  const caps = row.objectType === "table" && row.objectId
    ? await resolveTableShareCaps(row, row.objectId)
    : { mode: "view" as ShareMode, requestedMode: "view" as ShareMode, degraded: false, canEdit: false, sharerId: row.createdBy };
  return {
    id: row.id,
    token: row.token,
    objectType: row.objectType as ObjectShareLinkDTO["objectType"],
    objectId: row.objectId,
    baseId: row.baseId,
    viewId: row.viewId,
    mode: row.mode === "edit" ? "edit" : "view",
    effectiveMode: caps.mode,
    degraded: caps.degraded,
    canEdit: caps.canEdit,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    url: `/s/${row.token}`,
  };
}

tableShares.get("/:tableId/share", async (c) => {
  try {
    const userId = await requireUserId(c);
    const tableId = c.req.param("tableId");
    const access = await assertCanShareTable(userId, tableId);
    const rows = await prisma.shareLink.findMany({
      where: { objectType: "table", objectId: tableId },
      orderBy: { createdAt: "desc" },
    });
    return c.json({
      links: await Promise.all(rows.map(toDTO)),
      // 本人此刻能否开「可编辑」档位——供弹窗把该选项置灰。
      // 复用 assertCanShareTable 刚拿到的裁决结果，判定链与 canSharerGrantTableEdit /
      // assertSharerCanGrantEdit 完全同一条（resolveBaseAccessByTable -> tableAccessOf.update）。
      canGrantEdit: !!tableAccessOf(access, tableId)?.update,
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

tableShares.post("/:tableId/share", async (c) => {
  try {
    const userId = await requireUserId(c);
    const tableId = c.req.param("tableId");
    await assertCanShareTable(userId, tableId);

    const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法", code: "BAD_REQUEST" }, 400);

    if (parsed.data.viewId) {
      const v = await prisma.view.findFirst({ where: { id: parsed.data.viewId, tableId } });
      if (!v) return c.json({ error: "视图不存在或不属于该表", code: "BAD_REQUEST" }, 400);
    }

    // 硬约束：可编辑只发给本人此刻就有编辑权的人。前端置灰不算防线，这里必须再判一次。
    if (parsed.data.mode === "edit") {
      await assertSharerCanGrantEdit(userId, tableId);
    }

    const table = await prisma.table.findUniqueOrThrow({ where: { id: tableId }, select: { baseId: true } });
    const row = await prisma.shareLink.create({
      data: {
        baseId: table.baseId,
        token: genShareToken(),
        role: "viewer",
        objectType: "table",
        objectId: tableId,
        viewId: parsed.data.viewId ?? null,
        mode: parsed.data.mode,
        createdBy: userId,
        expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      },
    });
    audit(c, {
      event: "share_link_created",
      status: 201,
      actorId: userId,
      // 可编辑链接是一条外部写通道，审计必须能回答"谁在什么时候把哪张表开放成可写"。
      detail: { objectType: "table", objectId: tableId, mode: parsed.data.mode, viewId: parsed.data.viewId ?? null, linkId: row.id },
    });
    return c.json({ link: await toDTO(row) }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

tableShares.delete("/:tableId/share/:linkId", async (c) => {
  try {
    const userId = await requireUserId(c);
    const tableId = c.req.param("tableId");
    const linkId = c.req.param("linkId");
    const access = await assertCanShareTable(userId, tableId);

    const row = await prisma.shareLink.findFirst({ where: { id: linkId, objectType: "table", objectId: tableId } });
    if (!row) throw new HttpError(404, "分享链接不存在");
    // 自己建的自己能吊销；对本库有管理权的人也能（人走了/降权了链接不能悬着）。
    if (row.createdBy !== userId && !access.canManage) {
      throw new HttpError(403, "只有创建者或本库管理者可吊销该分享链接");
    }
    await prisma.shareLink.delete({ where: { id: linkId } });
    audit(c, {
      event: "share_link_revoked",
      status: 200,
      actorId: userId,
      detail: { objectType: "table", objectId: tableId, linkId, mode: row.mode },
    });
    return c.json({ ok: true });
  } catch (e) {
    return errorResponse(c, e);
  }
});
