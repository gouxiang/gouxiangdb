// apps/api/src/routes/kb/members.ts
// 知识库「谁能进来」的只读视图。
//
// 与 bases 的成员接口同源：权限只按角色配之后，逐库逐人的成员名册不再是授权入口，
// 加人/改档位/踢人三个写端点随之全部下线（kb_members 行只作为历史留档）。
// 留下的唯一一个 GET 回答"哪些角色覆盖到这个知识库、覆盖到多少人"，
// 并显式给出超级管理员/管理员的人数——这两类人不配库视野也能进，
// 不列出来会让管理员照着"没有任何角色能访问"的错误结论去补授权。

import { Hono } from "hono";
import { requireUserId, errorResponse } from "../../guards.js";
import { libraryVisibility } from "../../domain/authz/libraryVisibility.js";
import { requireKb } from "./shared.js";

export const membersRoutes = new Hono();

membersRoutes.get("/:kbId/members", async (c) => {
  try {
    const userId = await requireUserId(c);
    const kbId = c.req.param("kbId");
    await requireKb(userId, kbId);
    return c.json(await libraryVisibility("kb", kbId));
  } catch (e) {
    return errorResponse(c, e);
  }
});
