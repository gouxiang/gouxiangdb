// M5/S7 旧全局检索逻辑的可复用抽取（供旧 HTTP 路由与 v1 shadow 对拍共用同一真源）。
//
// 铁律：本文件是从 routes/search.ts【逐字搬迁】的检索逻辑，只把 prisma/原始 q 提为入参，
// 不改变任何取数顺序、截断口径、标题/snippet 派生规则与响应字段。旧 HTTP 路由的字节级
// golden（m5-search-golden / M5-S0）必须继续全绿——本抽取是"零行为 diff 抽函数"，不做优化。
//
// 这是有界预览（ADR-0005）：每表仅最旧 SEARCH_PREVIEW_LIMIT 条活记录入内存做子串匹配，
// 非全量召回；docs 支路用 Prisma contains。M5 新链路（query.ts）是全量派生库召回，二者
// 仅在"两模式都 FTS/LIKE 且旧有界预览可达"的交集上做 shadow 对拍（§6），向量不与本路对拍。

import type { PrismaClient } from "@prisma/client";
import { isComputedFieldType } from "../types.js";
import { SEARCH_PREVIEW_LIMIT, boundedPreviewMarker } from "../../routes/searchBounds.js";

interface LegacyRecordHit {
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
interface LegacyDocHit {
  type: "doc" | "canvas";
  kbId: string;
  kbName: string;
  docId: string;
  title: string;
  snippet: string;
}

/** 旧 /api/search 的响应体（records/docs + 恒定有界预览 marker；空 q 时不带 marker）。 */
export type LegacySearchResult =
  | { records: never[]; docs: never[] }
  | { records: LegacyRecordHit[]; docs: LegacyDocHit[]; boundedPreview: true; previewLimit: number };

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

/**
 * 旧全局检索（逐字搬迁自 routes/search.ts）。
 * @param client Prisma 客户端（路由传单例；测试/shadow 可注入临时库客户端）。
 * @param userId 已登录主体（旧权限只认 members/kb_members）。
 * @param rawQ 未 trim 的原始 q（函数内 trim，空串返回 {records:[],docs:[]}）。
 */
export async function runLegacyGlobalSearch(
  client: PrismaClient,
  userId: string,
  rawQ: string,
): Promise<LegacySearchResult> {
  const q = (rawQ ?? "").trim();
  if (!q) return { records: [], docs: [] };
  const lower = q.toLowerCase();
  const recordLimit = 60;
  const docLimit = 40;

  // ---- 1. 智能表格记录：用户作为成员的所有 Base ----
  const recordHits: LegacyRecordHit[] = [];
  const memberships = await client.member.findMany({
    where: { userId },
    include: { base: { select: { id: true, name: true, deletedAt: true } } },
  });
  for (const m of memberships) {
    if (recordHits.length >= recordLimit) break;
    const base = m.base;
    if (!base || base.deletedAt) continue;
    const tables = await client.table.findMany({
      where: { baseId: base.id, deletedAt: null },
      select: { id: true, name: true, primaryFieldId: true },
    });
    for (const t of tables) {
      if (recordHits.length >= recordLimit) break;
      const fields = await client.field.findMany({
        where: { tableId: t.id, deletedAt: null },
        select: { id: true, name: true, type: true },
      });
      const searchable = fields.filter((f) => !isComputedFieldType(f.type));
      // ADR-0005：每表只取前 SEARCH_PREVIEW_LIMIT 条活记录做内存子串匹配（有界预览，
      // 非全量召回）；知识库 docs 支路不受此限。M5 统一检索派生库落地后替换该口径。
      const recs = await client.record.findMany({
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
  const docHits: LegacyDocHit[] = [];
  const kbMembers = await client.kbMember.findMany({
    where: { userId, kb: { deletedAt: null } },
    include: { kb: { select: { id: true, name: true } } },
  });
  for (const km of kbMembers) {
    if (docHits.length >= docLimit) break;
    const docs = await client.kbDoc.findMany({
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
  return { records: recordHits, docs: docHits, ...boundedPreviewMarker() };
}
