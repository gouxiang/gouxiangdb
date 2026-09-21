// apps/api/src/routes/publicEmbed.ts
// 文档/画布中【嵌入的数据表预览】的分享态读取通道。
//
//   GET    /api/public/s/:token/embed/:tableId?viewId=&limit=&offset=   读预览
//   POST   /api/public/s/:token/embed/:tableId/records                  增（需宿主可编辑）
//   PATCH  /api/public/s/:token/embed/:tableId/records/:recordId        改
//   DELETE /api/public/s/:token/embed/:tableId/records/:recordId        删
//
// 登录态不在这里：直接复用 GET /api/views/:viewId + GET /api/records?tableId=&viewId=&limit=&offset=
// （routes/views.ts:124 与 routes/records.ts:64），两个接口都已按当前用户的库权限过滤，无需第三套。
//
// 分享态的三条硬口径：
//   1. 档位由【宿主文档/画布的分享设置】决定（只读/可编辑），外部人必须带着宿主 token 进来；
//      没有宿主 token 就没有这条通道，也就绕不过宿主分享设置去直接访问数据表。
//   2. 嵌入【不提升】该数据表自身的权限：字段可见性与写闸仍按【分享人】在该表所在库上的
//      裁决结果计算（shareCaps.ts），与该表自己的分享开关是否打开无关——
//      表级开关管的是"这张表能不能被单独外发"，不是"能不能被文档带出来"。
//   3. 宿主分享人的权限同样每次现算：他被降权，嵌入预览当次回落只读。

import { Hono } from "hono";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, errorResponse } from "../guards.js";
import { sourceIp } from "../utils/client-ip.js";
import type { EmbeddedTablePayload } from "@gx/shared-types";
import { resolveShareTarget } from "../domain/share/shareLinkLookup.js";
import { resolveDocShareCaps, resolveTableShareCaps } from "../domain/share/shareCaps.js";
import {
  externalCreateRecord,
  externalDeleteRecord,
  externalUpdateRecord,
  readSharedTable,
  sharePage,
} from "../domain/share/externalRecords.js";

export const publicEmbedRoutes = new Hono();

const patchSchema = z.object({ fields: z.record(z.unknown()) });

/**
 * 解析一次嵌入访问：宿主分享 -> 宿主档位 -> 该表在该档位下的当次能力。
 * 宿主必须是文档/画布分享：数据表链接里没有"嵌入"这回事。
 */
async function resolveEmbed(token: string, tableId: string) {
  const target = await resolveShareTarget(token);
  if (target.type !== "kb_doc") {
    throw new HttpError(404, "嵌入预览只能通过文档或画布的分享链接访问");
  }
  const host = await resolveDocShareCaps(target.doc.shareRole, target.doc.kbId, target.doc.shareCreatedBy);

  const table = await prisma.table.findFirst({
    where: { id: tableId, deletedAt: null },
    select: {
      id: true, name: true, icon: true, iconColor: true, primaryFieldId: true,
      baseId: true, base: { select: { name: true } },
    },
  });
  if (!table) throw new HttpError(404, "嵌入的数据表不存在或已删除");

  // 复用表分享的能力计算，只是把"申请档位"换成宿主档位、"分享人"换成宿主分享人。
  const caps = await resolveTableShareCaps(
    {
      id: "", token, objectType: "table", objectId: table.id, baseId: table.baseId,
      viewId: null, mode: host.mode, createdBy: host.sharerId, role: "viewer",
      expiresAt: null, createdAt: new Date(),
    },
    table.id,
  );
  return { caps, table: { ...table, baseName: table.base.name }, viaToken: token };
}

publicEmbedRoutes.get("/s/:token/embed/:tableId", async (c) => {
  try {
    const token = c.req.param("token");
    const { caps, table, viaToken } = await resolveEmbed(token, c.req.param("tableId"));
    const page = sharePage({ limit: c.req.query("limit"), offset: c.req.query("offset") });
    const viewId = c.req.query("viewId") ?? null;
    const payload = await readSharedTable(
      { tableId: table.id, viewId, limit: page.limit, offset: page.offset },
      caps,
      table,
    );
    const body: EmbeddedTablePayload = {
      tableId: table.id,
      viewId,
      canEdit: caps.canEdit,
      mode: caps.mode,
      degraded: caps.degraded,
      viaToken,
      table: payload.table,
      view: payload.view,
      fields: payload.fields,
      visibleFields: payload.visibleFields,
      records: payload.records,
      total: payload.total,
      filteredTotal: payload.filteredTotal,
      page: payload.page,
    };
    return c.json(body);
  } catch (e) {
    return errorResponse(c, e);
  }
});

publicEmbedRoutes.post("/s/:token/embed/:tableId/records", async (c) => {
  try {
    const token = c.req.param("token");
    const tableId = c.req.param("tableId");
    const { caps } = await resolveEmbed(token, tableId);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法", code: "BAD_REQUEST" }, 400);
    const created = await externalCreateRecord(
      { tableId, patch: parsed.data.fields, ip: sourceIp(c), token },
      caps,
    );
    return c.json({ record: { id: created.id }, canEdit: caps.canEdit, mode: caps.mode }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

publicEmbedRoutes.patch("/s/:token/embed/:tableId/records/:recordId", async (c) => {
  try {
    const token = c.req.param("token");
    const tableId = c.req.param("tableId");
    const { caps } = await resolveEmbed(token, tableId);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法", code: "BAD_REQUEST" }, 400);
    await externalUpdateRecord(
      { tableId, recordId: c.req.param("recordId"), patch: parsed.data.fields, ip: sourceIp(c), token },
      caps,
    );
    return c.json({ ok: true, canEdit: caps.canEdit, mode: caps.mode });
  } catch (e) {
    return errorResponse(c, e);
  }
});

publicEmbedRoutes.delete("/s/:token/embed/:tableId/records/:recordId", async (c) => {
  try {
    const token = c.req.param("token");
    const tableId = c.req.param("tableId");
    const { caps } = await resolveEmbed(token, tableId);
    await externalDeleteRecord(
      { tableId, recordId: c.req.param("recordId"), patch: {}, ip: sourceIp(c), token },
      caps,
    );
    return c.json({ ok: true, canEdit: caps.canEdit, mode: caps.mode });
  } catch (e) {
    return errorResponse(c, e);
  }
});
