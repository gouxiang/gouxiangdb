// apps/api/src/domain/linkable/linkableQuery.ts
// 「关联插入」选择器的可见对象查询：只返回当前用户所属角色【可见】的对象。
//
// 过滤必须在后端做：前端过滤等于没过滤——请求照常发出去，对象 id 与标题已经在响应里了，
// 抓一次包就能看到本不该看见的东西（库名、文档标题本身就是信息泄漏）。
//
// 分工：可见性一律来自【库权限】（domain/authz/libraryPolicy），不读任何组织动作位。
//   组织动作（view_directory / manage_members…）管的是"能不能进通讯录、能不能管人"，
//   与"能不能看见这个库里的这张表"是两件事；混用会让"能看通讯录"变成"能看全部数据"。
//
// 逐对象判据：
//   base / kb  —— 库裁决 visible
//   table      —— 所在库 visible 且 tableAccessOf(...).read
//   doc/canvas —— 所在知识库 visible 且 contentAccessOf(...).read

import { prisma } from "../../db.js";
import type { LinkableItem, LinkableType } from "@gx/shared-types";
import {
  contentAccessOf,
  resolveManyAccess,
  tableAccessOf,
  visibleLibraryIds,
} from "../authz/libraryPolicy.js";

/** 单次扫描上限：超过即截断（truncated=true），防止大库把列表接口拖成慢查询。 */
const SCAN_CAP = 500;

export interface LinkableQuery {
  userId: string;
  /** 名称/标题包含匹配（大小写不敏感由 SQLite LIKE 保证 ASCII 段）。 */
  q: string;
  types: readonly LinkableType[];
  limit: number;
}

interface Row {
  id: string;
  title: string;
  libraryId: string | null;
  libraryName: string | null;
  libraryKind: "base" | "kb" | null;
  type: LinkableType;
  icon: string | null;
  iconColor: string | null;
  parentId: string | null;
  updatedAt: Date | null;
}

function hit(q: string, title: string): boolean {
  if (!q) return true;
  return title.toLowerCase().includes(q.toLowerCase());
}

/** 沿 parentId 向上拼面包屑（只在同一批已取回的行里走，不额外查库）。 */
function pathOf(row: Row, byId: Map<string, Row>): string[] {
  const out: string[] = [];
  let cur = row.parentId;
  const seen = new Set<string>();
  for (let i = 0; i < 50 && cur; i++) {
    if (seen.has(cur)) break; // 数据异常自环
    seen.add(cur);
    const p = byId.get(cur);
    if (!p) break;
    out.unshift(p.title);
    cur = p.parentId;
  }
  return out;
}

export async function searchLinkable(query: LinkableQuery): Promise<{ items: LinkableItem[]; truncated: boolean }> {
  const want = new Set(query.types.length ? query.types : ["base", "kb", "table", "doc", "canvas"]);
  const rows: Row[] = [];

  if (want.has("base") || want.has("table")) {
    const { all, ids } = await visibleLibraryIds(query.userId, "base");
    const bases = await prisma.base.findMany({
      where: { deletedAt: null, ...(all ? {} : { id: { in: ids } }) },
      select: { id: true, name: true, icon: true, iconColor: true },
      orderBy: { createdAt: "desc" },
    });
    // 批量裁决，避免逐库求值（列表场景的 N+1）。
    const accessMap = await resolveManyAccess(query.userId, "base", bases.map((b) => b.id));
    const visibleBases = bases.filter((b) => accessMap.get(b.id)?.visible);
    const nameOf = new Map(visibleBases.map((b) => [b.id, b.name]));

    if (want.has("base")) {
      for (const b of visibleBases) {
        if (!hit(query.q, b.name)) continue;
        rows.push({
          id: b.id, title: b.name, libraryId: null, libraryName: null, libraryKind: "base",
          type: "base", icon: b.icon, iconColor: b.iconColor, parentId: null, updatedAt: null,
        });
      }
    }

    if (want.has("table")) {
      const tables = await prisma.table.findMany({
        where: { baseId: { in: visibleBases.map((b) => b.id) }, deletedAt: null },
        select: { id: true, name: true, icon: true, iconColor: true, baseId: true },
        orderBy: { createdAt: "desc" },
        take: SCAN_CAP,
      });
      for (const t of tables) {
        const access = accessMap.get(t.baseId);
        if (!access || !tableAccessOf(access, t.id).read) continue;
        if (!hit(query.q, t.name)) continue;
        rows.push({
          id: t.id, title: t.name, libraryId: t.baseId, libraryName: nameOf.get(t.baseId) ?? null,
          libraryKind: "base", type: "table", icon: t.icon, iconColor: t.iconColor, parentId: null, updatedAt: null,
        });
      }
    }
  }

  if (want.has("kb") || want.has("doc") || want.has("canvas")) {
    const { all, ids } = await visibleLibraryIds(query.userId, "kb");
    const kbs = await prisma.knowledgeBase.findMany({
      where: { deletedAt: null, ...(all ? {} : { id: { in: ids } }) },
      select: { id: true, name: true, icon: true, iconColor: true },
      orderBy: { createdAt: "desc" },
    });
    const accessMap = await resolveManyAccess(query.userId, "kb", kbs.map((k) => k.id));
    const visibleKbs = kbs.filter((k) => accessMap.get(k.id)?.visible);
    const nameOf = new Map(visibleKbs.map((k) => [k.id, k.name]));

    if (want.has("kb")) {
      for (const k of visibleKbs) {
        if (!hit(query.q, k.name)) continue;
        rows.push({
          id: k.id, title: k.name, libraryId: null, libraryName: null, libraryKind: "kb",
          type: "kb", icon: k.icon, iconColor: k.iconColor, parentId: null, updatedAt: null,
        });
      }
    }

    if (want.has("doc") || want.has("canvas")) {
      const docs = await prisma.kbDoc.findMany({
        where: { kbId: { in: visibleKbs.map((k) => k.id) }, deletedAt: null },
        select: { id: true, kbId: true, kind: true, title: true, parentId: true, updatedAt: true },
        orderBy: { updatedAt: "desc" },
        take: SCAN_CAP,
      });
      const byId = new Map<string, Row>();
      for (const d of docs) {
        byId.set(d.id, {
          id: d.id, title: d.title, libraryId: d.kbId, libraryName: nameOf.get(d.kbId) ?? null,
          libraryKind: "kb", type: d.kind === "canvas" ? "canvas" : "doc", icon: null, iconColor: null,
          parentId: d.parentId, updatedAt: d.updatedAt,
        });
      }
      for (const d of docs) {
        const row = byId.get(d.id)!;
        if (!want.has(row.type)) continue;
        const access = accessMap.get(d.kbId);
        if (!access || !contentAccessOf(access).read) continue;
        if (!hit(query.q, d.title)) continue;
        rows.push(row);
      }
      // 面包屑必须在过滤前建好索引，故在最后统一计算（pathOf 只用 byId，不再查库）。
      for (const r of rows) {
        if (r.type === "doc" || r.type === "canvas") {
          (r as Row & { path?: string[] }).path = pathOf(r, byId);
        }
      }
    }
  }

  const truncated = rows.length > query.limit;
  const items: LinkableItem[] = rows.slice(0, query.limit).map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    libraryId: r.libraryId,
    libraryName: r.libraryName,
    libraryKind: r.libraryKind,
    icon: r.icon,
    iconColor: r.iconColor,
    path: (r as Row & { path?: string[] }).path ?? [],
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
  }));
  return { items, truncated };
}
