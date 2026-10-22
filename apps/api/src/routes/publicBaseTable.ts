// apps/api/src/routes/publicBaseTable.ts
// 库（base）分享链接作用域内的「单表只读」通道（匿名可访问，无 JWT）。
//
// 挂载方式：routes/public.ts 里 pub.route("/", publicBaseTableRoutes)，故 URL 为
//   GET /api/public/s/:baseToken/t/:tableId           表结构 + 首屏记录（只读）
//   GET /api/public/s/:baseToken/t/:tableId/records   翻页读记录（只读）
//
// 业务目标：外部人拿到一条【库分享链接】，无需登录即可只读看到库信息，并能点进该库中
// 「单独开启了分享」的表看网格数据。绝不能让访问者枚举/读到没有独立分享链接的表，也不能
// 越过表分享人的字段权限看到隐藏字段。
//
// 安全口径（全部复用既有 domain，本文件只做参数与出口，不另写一套取数/裁剪）：
//   1. baseToken 必须解析为有效的 base 分享链接（resolveShareTarget，未过期、库级总闸开）。
//   2. tableId 必须确实出现在该库的 shareableTables 清单里——即该表 shareEnabled=1 且存在
//      一条有效、未撤销、未过期的独立 table 分享链接。不属于该库 / 未单独分享的表一律 404，
//      不区分"表不存在/未分享"，避免枚举。
//   3. 通过后借用该表自己的 table 分享链接上下文（link/caps），复用 readSharedTable /
//      readSharedRecords 取数；字段裁剪按【该表分享链接创建者】的字段权限（shareVisibleFields），
//      与直接持有 table token 访问 /s/:tableToken 看到的字段集完全一致。
//   4. 这两个端点只读，不提供任何写。

import { Hono } from "hono";
import type { PublicTablePayload } from "@gx/shared-types";
import { HttpError, errorResponse } from "../guards.js";
import { resolveShareTarget, shareableTables } from "../domain/share/shareLinkLookup.js";
import { resolveTableShareCaps } from "../domain/share/shareCaps.js";
import { readSharedRecords, readSharedTable, sharePage } from "../domain/share/externalRecords.js";
import type { ShareCaps } from "../domain/share/shareCaps.js";
import type { ShareLinkRow } from "../domain/share/shareLinkLookup.js";

export const publicBaseTableRoutes = new Hono();

interface BaseTableScope {
  /** 该表自身有效的 table 分享链接行（字段裁剪/档位以它的创建者为准）。 */
  link: ShareLinkRow;
  tableId: string;
  table: PublicTablePayload["table"];
  caps: ShareCaps;
}

/**
 * 解析 baseToken + tableId -> 该表自身的 table 分享上下文 + 只读 caps。
 * 任何一环不满足都抛 404（统一口径，不泄漏"存在但未分享"）。
 */
async function resolveBaseTableScope(baseToken: string, tableId: string): Promise<BaseTableScope> {
  // 1) baseToken 必须是有效的库分享链接（失效/过期/非 base 族都在此被挡）。
  //    统一归一为 404：库总闸关闭时 resolveShareTarget 本会抛 403，但 base 作用域端点对外
  //    不区分"链接不存在/已过期/库关分享"，避免凭状态码枚举，一律 404。
  let baseTarget: Awaited<ReturnType<typeof resolveShareTarget>>;
  try {
    baseTarget = await resolveShareTarget(baseToken);
  } catch (e) {
    throw e instanceof HttpError ? new HttpError(404, "分享链接已失效或被取消") : e;
  }
  if (baseTarget.type !== "base") {
    throw new HttpError(404, "分享链接已失效或被取消");
  }

  // 2) tableId 必须出现在该库的「可分享表清单」里：属于该库 + shareEnabled + 有有效 table 链接。
  //    直接复用 shareableTables，保证「外壳列出的」与「点得开的」是同一判定，不产生第二套口径。
  const visible = await shareableTables(baseTarget.base.id);
  const item = visible.find((t) => t.id === tableId);
  if (!item) {
    throw new HttpError(404, "该数据表未在此分享范围内");
  }

  // 3) 借用该表自身的 table 分享链接：再解析一次它的 token，重算未过期/两级开关/档位。
  //    readSharedTable/readSharedRecords 只认 table 分享上下文，这里把 base 作用域访问
  //    归一到「持有该表 token」的同一条取数路径，字段集天然一致。
  //    竞态（清单生成后该表恰被关分享 -> 解析抛 403）同样归一为 404，不泄漏状态。
  let tableTarget: Awaited<ReturnType<typeof resolveShareTarget>>;
  try {
    tableTarget = await resolveShareTarget(item.token);
  } catch (e) {
    throw e instanceof HttpError ? new HttpError(404, "该数据表未在此分享范围内") : e;
  }
  if (tableTarget.type !== "table") {
    throw new HttpError(404, "该数据表未在此分享范围内");
  }

  const caps = await resolveTableShareCaps(tableTarget.link, tableTarget.table.id);
  return { link: tableTarget.link, tableId: tableTarget.table.id, table: tableTarget.table, caps };
}

// 表结构 + 首屏记录（只读）
publicBaseTableRoutes.get("/s/:baseToken/t/:tableId", async (c) => {
  try {
    const scope = await resolveBaseTableScope(c.req.param("baseToken"), c.req.param("tableId"));
    const page = sharePage({ limit: c.req.query("limit"), offset: c.req.query("offset") });
    const payload = await readSharedTable(
      { tableId: scope.tableId, viewId: scope.link.viewId, limit: page.limit, offset: page.offset },
      scope.caps,
      scope.table,
    );
    // 回填该表自身 token：与直接 GET /s/:tableToken 的响应逐字段同构（字段集一致的可观测保证）。
    return c.json({ ...payload, token: scope.link.token });
  } catch (e) {
    return errorResponse(c, e);
  }
});

// 翻页读记录（只读）
publicBaseTableRoutes.get("/s/:baseToken/t/:tableId/records", async (c) => {
  try {
    const scope = await resolveBaseTableScope(c.req.param("baseToken"), c.req.param("tableId"));
    const page = sharePage({ limit: c.req.query("limit"), offset: c.req.query("offset") });
    const payload = await readSharedRecords(
      { tableId: scope.tableId, viewId: scope.link.viewId, limit: page.limit, offset: page.offset },
      scope.caps,
    );
    return c.json(payload);
  } catch (e) {
    return errorResponse(c, e);
  }
});
