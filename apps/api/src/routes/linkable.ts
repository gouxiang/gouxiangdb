// apps/api/src/routes/linkable.ts
// 关联插入选择器的后端数据源：只回当前用户可见的可关联对象。
//
//   GET /api/linkable?q=关键词&types=base,kb,table,doc,canvas&limit=50
//
// 前端拿到什么就能关联什么，所以过滤必须在服务端按 libraryPolicy 完成
// （实现见 domain/linkable/linkableQuery.ts）。响应里不会出现任何不可见对象的 id 或标题。

import { Hono } from "hono";
import { errorResponse, requireUserId } from "../guards.js";
import { LINKABLE_TYPES, type LinkableType } from "@gx/shared-types";
import { searchLinkable } from "../domain/linkable/linkableQuery.js";

export const linkable = new Hono();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseTypes(raw: string | undefined): LinkableType[] {
  if (!raw) return [];
  const allow = new Set<string>(LINKABLE_TYPES);
  return raw.split(",").map((s) => s.trim()).filter((s) => allow.has(s)) as LinkableType[];
}

linkable.get("/", async (c) => {
  try {
    const userId = await requireUserId(c);
    const rawLimit = Number(c.req.query("limit") ?? DEFAULT_LIMIT);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_LIMIT, MAX_LIMIT);
    const q = (c.req.query("q") ?? "").trim().slice(0, 100);
    const result = await searchLinkable({ userId, q, types: parseTypes(c.req.query("types")), limit });
    return c.json(result);
  } catch (e) {
    return errorResponse(c, e);
  }
});
