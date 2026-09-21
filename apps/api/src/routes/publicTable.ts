// apps/api/src/routes/publicTable.ts
// 公开分享链接上的「数据表 + 视图」读写（匿名可访问，无 JWT）。
//
// 挂载方式：routes/public.ts 里 pub.route("/", publicTableRoutes)，故 URL 仍是
//   GET    /api/public/s/:token/records?limit=&offset=     翻页读记录
//   POST   /api/public/s/:token/records                    新建记录（需可编辑）
//   PATCH  /api/public/s/:token/records/:recordId          改记录（需可编辑）
//   DELETE /api/public/s/:token/records/:recordId          删记录（需可编辑）
//
// 安全口径（与路由层无关，全部由 domain/share 保证，本文件只做参数与出口）：
//   1. 每次请求都重新解析令牌 + 重新算档位，不缓存、不复用上次结论——分享人被降权即当次变只读。
//   2. 写权限只在这条链接上生效，不写任何角色/成员/视野数据，外部人不会获得系统身份。
//   3. 写入按【分享人】的字段权限过闸（"仅可见"/"隐藏"字段拒写），成功与被拒都落审计。

import { Hono } from "hono";
import { z } from "zod";
import { HttpError, errorResponse } from "../guards.js";
import { sourceIp } from "../utils/client-ip.js";
import { resolveShareTarget } from "../domain/share/shareLinkLookup.js";
import { resolveTableShareCaps } from "../domain/share/shareCaps.js";
import {
  externalCreateRecord,
  externalDeleteRecord,
  externalUpdateRecord,
  readSharedRecords,
  sharePage,
} from "../domain/share/externalRecords.js";

export const publicTableRoutes = new Hono();

const patchSchema = z.object({ fields: z.record(z.unknown()) });

/** 解析并断言这是一个数据表分享（文档/画布与库级分享没有记录读写面）。 */
async function requireTableShare(token: string) {
  const target = await resolveShareTarget(token);
  if (target.type !== "table") {
    throw new HttpError(404, "该分享链接不是数据表分享");
  }
  const caps = await resolveTableShareCaps(target.link, target.table.id);
  return { target, caps, tableId: target.table.id };
}

// 翻页读记录（首屏数据走 GET /api/public/s/:token，这里只供翻页/刷新）
publicTableRoutes.get("/s/:token/records", async (c) => {
  try {
    const { target, caps, tableId } = await requireTableShare(c.req.param("token"));
    const page = sharePage({ limit: c.req.query("limit"), offset: c.req.query("offset") });
    const payload = await readSharedRecords(
      { tableId, viewId: target.link.viewId, limit: page.limit, offset: page.offset },
      caps,
    );
    return c.json(payload);
  } catch (e) {
    return errorResponse(c, e);
  }
});

publicTableRoutes.post("/s/:token/records", async (c) => {
  try {
    const { caps, tableId } = await requireTableShare(c.req.param("token"));
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法", code: "BAD_REQUEST" }, 400);
    const created = await externalCreateRecord(
      { tableId, patch: parsed.data.fields, ip: sourceIp(c), token: c.req.param("token") },
      caps,
    );
    return c.json({ record: { id: created.id }, canEdit: caps.canEdit, mode: caps.mode }, 201);
  } catch (e) {
    return errorResponse(c, e);
  }
});

publicTableRoutes.patch("/s/:token/records/:recordId", async (c) => {
  try {
    const { caps, tableId } = await requireTableShare(c.req.param("token"));
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "参数不合法", code: "BAD_REQUEST" }, 400);
    await externalUpdateRecord(
      { tableId, recordId: c.req.param("recordId"), patch: parsed.data.fields, ip: sourceIp(c), token: c.req.param("token") },
      caps,
    );
    return c.json({ ok: true, canEdit: caps.canEdit, mode: caps.mode });
  } catch (e) {
    return errorResponse(c, e);
  }
});

publicTableRoutes.delete("/s/:token/records/:recordId", async (c) => {
  try {
    const { caps, tableId } = await requireTableShare(c.req.param("token"));
    await externalDeleteRecord(
      { tableId, recordId: c.req.param("recordId"), patch: {}, ip: sourceIp(c), token: c.req.param("token") },
      caps,
    );
    return c.json({ ok: true, canEdit: caps.canEdit, mode: caps.mode });
  } catch (e) {
    return errorResponse(c, e);
  }
});
