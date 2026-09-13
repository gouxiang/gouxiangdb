// apps/api/src/routes/search.ts
// 全局统一搜索：跨「智能表格记录」+「知识库文档/画布」聚合检索。
// 仅返回当前用户有权访问的资源（Base 成员 / 知识库成员）。
// 知识库内部的限定搜索仍走 kb 路由的 GET /api/kb/:kbId/docs?q=（作用域单一知识库）。

import { Hono } from "hono";
import { prisma } from "../db.js";
import { requireUserId, errorResponse } from "../guards.js";
import { isComputedFieldType } from "../domain/types.js";
import { SEARCH_PREVIEW_LIMIT, boundedPreviewMarker } from "./searchBounds.js";

export const search = new Hono();

function parseStoredFields(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

interface RecordHit {
  type: "record";
  baseId: string;
  baseName: string;
  tableId: string;
  tableName: string;
  recordId: string;
  title: string;
  snippet: string;
  matchedField: string;
}
interface DocHit {
  type: "doc" | "canvas";
  kbId: string;
  kbName: string;
  docId: string;
  title: string;
  snippet: string;
}

search.get("/", async (c) => {
  try {
    const userId = await requireUserId(c);
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ records: [], docs: [] });
    const lower = q.toLowerCase();
    const recordLimit = 60;
    const docLimit = 40;

    // ---- 1. 智能表格记录：用户作为成员的所有 Base ----
    const recordHits: RecordHit[] = [];
    const memberships = await prisma.member.findMany({
      where: { userId },
      include: { base: { select: { id: true, name: true, deletedAt: true } } },
    });
    for (const m of memberships) {
      if (recordHits.length >= recordLimit) break;
      const base = m.base;
      if (!base || base.deletedAt) continue;
      const tables = await prisma.table.findMany({
        where: { baseId: base.id, deletedAt: null },
        select: { id: true, name: true, primaryFieldId: true },
      });
      for (const t of tables) {
        if (recordHits.length >= recordLimit) break;
        const fields = await prisma.field.findMany({
          where: { tableId: t.id, deletedAt: null },
          select: { id: true, name: true, type: true },
        });
        const searchable = fields.filter((f) => !isComputedFieldType(f.type));
        // ADR-0005：每表只取前 SEARCH_PREVIEW_LIMIT 条活记录做内存子串匹配（有界预览，
        // 非全量召回）；知识库 docs 支路不受此限。M5 统一检索派生库落地后替换该口径。
        const recs = await prisma.record.findMany({
          where: { tableId: t.id, deletedAt: null },
          orderBy: { createdAt: "asc" },
          take: SEARCH_PREVIEW_LIMIT,
        });
        for (const r of recs) {
          const stored = parseStoredFields(r.fields);
          const pv = stored[t.primaryFieldId];
          let title = pv !== undefined && pv !== null && pv !== "" ? String(pv) : "";
          let matched = "";
          let snippet = "";
          for (const f of searchable) {
            const v = stored[f.id];
            if (v === null || v === undefined || v === "") continue;
            const text = Array.isArray(v)
              ? v.map((x) => (x && typeof x === "object" && "title" in (x as object) ? String((x as { title: unknown }).title) : String(x))).join(", ")
              : String(v);
            if (text.toLowerCase().includes(lower)) {
              matched = f.name;
              snippet = text.length > 60 ? `${text.slice(0, 60)}…` : text;
              break;
            }
          }
          if (!matched) continue;
          if (!title) title = snippet;
          recordHits.push({
            type: "record",
            baseId: base.id,
            baseName: base.name,
            tableId: t.id,
            tableName: t.name,
            recordId: r.id,
            title,
            snippet,
            matchedField: matched,
          });
          if (recordHits.length >= recordLimit) break;
        }
      }
    }

    // ---- 2. 知识库文档 / 画布：用户作为成员的所有知识库 ----
    const docHits: DocHit[] = [];
    const kbMembers = await prisma.kbMember.findMany({
      where: { userId, kb: { deletedAt: null } },
      include: { kb: { select: { id: true, name: true } } },
    });
    for (const km of kbMembers) {
      if (docHits.length >= docLimit) break;
      const docs = await prisma.kbDoc.findMany({
        where: {
          kbId: km.kb.id,
          deletedAt: null,
          OR: [{ title: { contains: q } }, { searchText: { contains: q } }],
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: { id: true, kind: true, title: true, searchText: true },
      });
      for (const d of docs) {
        if (docHits.length >= docLimit) break;
        const idx = d.searchText ? d.searchText.toLowerCase().indexOf(lower) : -1;
        const snippet = idx >= 0 && d.searchText
          ? d.searchText.slice(Math.max(0, idx - 10), idx + 50).trim()
          : "";
        docHits.push({
          type: d.kind === "canvas" ? "canvas" : "doc",
          kbId: km.kb.id,
          kbName: km.kb.name,
          docId: d.id,
          title: d.title,
          snippet,
        });
      }
    }

    // additive：records 为有界预览（ADR-0005），docs 支路有自己的 take；挂标记供前端提示。
    return c.json({ records: recordHits, docs: docHits, ...boundedPreviewMarker() });
  } catch (e) {
    return errorResponse(c, e);
  }
});
