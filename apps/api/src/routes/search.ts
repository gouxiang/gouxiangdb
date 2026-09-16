// apps/api/src/routes/search.ts
// 全局统一搜索：跨「智能表格记录」+「知识库文档/画布」聚合检索。
// 仅返回当前用户有权访问的资源（Base 成员 / 知识库成员）。
// 知识库内部的限定搜索仍走 kb 路由的 GET /api/kb/:kbId/docs?q=（作用域单一知识库）。
//
// M5/S7：检索实现逐字搬到 domain/search/legacySearch.ts（供 v1 shadow 对拍复用同一真源）；
// 本路由只做鉴权、取 q、调服务、回响应——HTTP 行为与响应字节保持完全不变（M5-S0 golden 兜底）。

import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUserId, errorResponse } from "../guards.js";
import { runLegacyGlobalSearch } from "../domain/search/legacySearch.js";

export const search = new Hono();

search.get("/", async (c) => {
  try {
    const userId = await requireUserId(c);
    const rawQ = c.req.query("q") ?? "";
    const result = await runLegacyGlobalSearch(prisma, userId, rawQ);
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e);
  }
});
