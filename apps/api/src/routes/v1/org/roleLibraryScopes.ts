// apps/api/src/routes/v1/org/roleLibraryScopes.ts
// 「角色 × 库」库权限段的读写端点（B 段权限的配置面）。
//
// 端点形态：
//   GET  /api/v1/org/library-scopes?roleId=xxx          列出某角色的全部库视野
//   PUT  /api/v1/org/library-scopes {items:[...]}       整体替换某角色的库视野（diff upsert/删除）
//   GET  /api/v1/org/libraries/:kind/:id/visibility     这个库被哪些角色覆盖（只读）
//
// 门控：全部走 edit_roles（与角色编辑同一枚）——库权限就是角色定义的一部分，
// 单独发明一枚动作位只会让"能改角色但不能改它的库权限"这种半吊子状态成为可能。
//
// PUT 为什么是整体替换而不是逐条 PATCH：
// 库权限的语义是"这个角色能进哪些库"，是一份清单。逐条改会让"取消勾选"与"没提交"
// 无法区分（HTTP 语义里二者都不在请求体里），从而出现删不干净的授权残留。
// 整体替换是唯一不留歧义的形态。

import { Hono } from "hono";
import { prisma, withWriteTx } from "../../../db.js";
import { HttpError, errorResponse } from "../../../guards.js";
import { requireOrgAction } from "../../../middleware/authActive.js";
import type { LibraryKind, PutLibraryScopeInput } from "@gx/shared-types";
import { parseScopeInput, toScopeDTO } from "../../../domain/authz/libraryScopeConfig.js";
import { libraryVisibility } from "../../../domain/authz/libraryVisibility.js";

export const libraryScopeRoutes = new Hono();

/** 库名批量查询：一次拉齐，避免逐条 N+1。 */
async function libraryNames(rows: Array<{ libraryKind: string; libraryId: string }>): Promise<Map<string, string>> {
  const baseIds = rows.filter((r) => r.libraryKind === "base").map((r) => r.libraryId);
  const kbIds = rows.filter((r) => r.libraryKind === "kb").map((r) => r.libraryId);
  const out = new Map<string, string>();
  if (baseIds.length) {
    const bases = await prisma.base.findMany({ where: { id: { in: baseIds } }, select: { id: true, name: true } });
    for (const b of bases) out.set(`base:${b.id}`, b.name);
  }
  if (kbIds.length) {
    const kbs = await prisma.knowledgeBase.findMany({ where: { id: { in: kbIds } }, select: { id: true, name: true } });
    for (const k of kbs) out.set(`kb:${k.id}`, k.name);
  }
  return out;
}

libraryScopeRoutes.get("/library-scopes", requireOrgAction("edit_roles"), async (c) => {
  try {
    const roleId = c.req.query("roleId");
    if (!roleId) throw new HttpError(400, "缺少 roleId");
    const live = await prisma.role.findFirst({ where: { id: roleId, deletedAt: null }, select: { id: true } });
    if (!live) throw new HttpError(404, "角色不存在或已删除");
    const rows = await prisma.roleLibraryScope.findMany({ where: { roleId }, orderBy: { updatedAt: "desc" } });
    const names = await libraryNames(rows);
    return c.json({
      roleId,
      scopes: rows.map((r) => toScopeDTO(r, names.get(`${r.libraryKind}:${r.libraryId}`) ?? "")),
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

libraryScopeRoutes.put("/library-scopes", requireOrgAction("edit_roles"), async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new HttpError(400, "请求体必须是 JSON 对象");
    const rec = body as Record<string, unknown>;
    const roleId = typeof rec.roleId === "string" ? rec.roleId : "";
    if (!roleId) throw new HttpError(400, "缺少 roleId");
    const items = Array.isArray(rec.items) ? rec.items : [];
    const wanted: PutLibraryScopeInput[] = items.map((it) =>
      parseScopeInput((it ?? {}) as Record<string, unknown>));

    // 去重：同一 (kind, libraryId) 以最后一条为准（与 PUT 整体替换的语义一致）。
    const byKey = new Map<string, PutLibraryScopeInput>();
    for (const w of wanted) byKey.set(`${w.libraryKind}:${w.libraryId}`, w);

    const actorId = c.get("auth").userId;
    const saved = await withWriteTx("org.role.libraryScopes", async (tx) => {
      const live = await tx.role.findFirst({ where: { id: roleId, deletedAt: null }, select: { id: true } });
      if (!live) throw new HttpError(404, "角色不存在或已删除");

      const current = await tx.roleLibraryScope.findMany({ where: { roleId } });
      const currentKeys = new Set(current.map((r) => `${r.libraryKind}:${r.libraryId}`));
      const wantKeys = new Set(byKey.keys());

      for (const row of current) {
        if (!wantKeys.has(`${row.libraryKind}:${row.libraryId}`)) {
          await tx.roleLibraryScope.delete({ where: { id: row.id } });
        }
      }
      for (const [key, w] of byKey) {
        const data = {
          canManage: w.canManage ? 1 : 0,
          visible: w.visible ? 1 : 0,
          config: JSON.stringify(w.config ?? { tables: {}, fields: {} }),
        };
        if (currentKeys.has(key)) {
          await tx.roleLibraryScope.updateMany({
            where: { roleId, libraryKind: w.libraryKind, libraryId: w.libraryId },
            data,
          });
        } else {
          await tx.roleLibraryScope.create({
            data: {
              roleId, libraryKind: w.libraryKind, libraryId: w.libraryId,
              ...data,
            },
          });
        }
      }
      void actorId;
      return tx.roleLibraryScope.findMany({ where: { roleId }, orderBy: { updatedAt: "desc" } });
    });
    const names = await libraryNames(saved);
    return c.json({
      roleId,
      scopes: saved.map((r) => toScopeDTO(r, names.get(`${r.libraryKind}:${r.libraryId}`) ?? "")),
    });
  } catch (e) {
    return errorResponse(c, e);
  }
});

libraryScopeRoutes.get("/libraries/:kind/:id/visibility", requireOrgAction("view_directory"), async (c) => {
  try {
    const kind = c.req.param("kind") === "kb" ? "kb" : ("base" as LibraryKind);
    const id = c.req.param("id");
    if (!id) throw new HttpError(400, "缺少库 id");
    return c.json(await libraryVisibility(kind, id));
  } catch (e) {
    return errorResponse(c, e);
  }
});
