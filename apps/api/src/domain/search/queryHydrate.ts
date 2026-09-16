// M5/S7 命中实体装配 + mask 摘要重拼（§4.5 步骤 8 / §4.7 规则 6）。
//
// 召回与 RRF 只产出 (entityType,entityId,nodeId + 最佳 chunk)；出口的标题、定位上下文与
// snippet 由本模块回主库装配。关键：record 的 snippet 只用【该主体可见字段】重拼——
// 召回侧 field chunk 已在 KNN/MATCH 前被 temp_field_grant 收敛（mask 值根本不进候选），
// 这里第二道保证即便最佳 chunk 是 field，也只呈现白名单字段；matchedField 对 mask 字段返 null，
// 措辞不出现"无权限"、不反证字段存在。doc/canvas 无字段概念，直接用命中 chunk 文本窗口。
//
// 纯编排：只通过注入的 Prisma 客户端读主库，不做权限判定（可见集已由 scope/decide 封口）。

import type { PrismaClient } from "@prisma/client";
import { extractFieldText } from "./chunks.js";
import type { EntityRef, HydratedEntity } from "./queryTypes.js";

function parseFields(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** snippet 截断口径与旧检索一致：超 60 字取前 60 + 省略号。 */
function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * 批量装配命中实体。masked: tableNodeId -> 该主体允许字段白名单（仅有 mask 的表有 key）。
 * record：title 取 primaryField（mask/空则回退 record id，§4.7），snippet 只拼可见字段；
 * doc/canvas：title 取 kbDoc.title，snippet 用命中 chunk 文本窗口。
 */
export async function hydrateEntities(
  client: PrismaClient,
  refs: EntityRef[],
  masked: Record<string, readonly string[]>,
): Promise<HydratedEntity[]> {
  const recordIds = refs.filter((r) => r.type === "record").map((r) => r.entityId);
  const docIds = refs.filter((r) => r.type !== "record").map((r) => r.entityId);

  const [records, docs] = await Promise.all([
    recordIds.length
      ? client.record.findMany({
          where: { id: { in: recordIds }, deletedAt: null },
          select: { id: true, tableId: true, fields: true, table: { select: { id: true, name: true, baseId: true, primaryFieldId: true, base: { select: { id: true, name: true } } } } },
        })
      : Promise.resolve([]),
    docIds.length
      ? client.kbDoc.findMany({
          where: { id: { in: docIds }, deletedAt: null },
          select: { id: true, title: true, kbId: true, kb: { select: { id: true, name: true } } },
        })
      : Promise.resolve([]),
  ]);

  const out = new Map<string, HydratedEntity>();

  for (const rec of records) {
    const ref = refs.find((r) => r.type === "record" && r.entityId === rec.id)!;
    const t = rec.table;
    const allow = masked[t.id]; // undefined=无 mask 全字段；数组=仅白名单
    const values = parseFields(rec.fields);

    // title：primary 可见且有值用之，否则回退 record id（不泄漏被 mask 的主字段业务值）。
    const primaryVal = values[t.primaryFieldId];
    const primaryVisible = allow === undefined || allow.includes(t.primaryFieldId);
    const title =
      primaryVisible && primaryVal !== null && primaryVal !== undefined && primaryVal !== ""
        ? String(primaryVal)
        : rec.id;

    // snippet：仅当最佳 chunk 是 field 且该字段可见时回显其值；identity/被 mask -> 中性空串。
    let snippet = "";
    let matchedField: string | null = null;
    if (ref.best.chunkKind === "field" && ref.best.fieldId) {
      const fid = ref.best.fieldId;
      const visible = allow === undefined || allow.includes(fid);
      if (visible) {
        snippet = clip(ref.best.body || extractFieldText(values[fid]));
        matchedField = ref.best.title || null; // field chunk 的 title 即字段名
      }
      // 被 mask：matchedField 保持 null、snippet 留空，不反证字段存在（§4.7 规则 6）。
    }

    out.set(`record:${rec.id}`, {
      type: "record",
      entityId: rec.id,
      title,
      snippet,
      context: {
        baseId: t.base.id, baseName: t.base.name,
        tableId: t.id, tableName: t.name,
      },
      matchedField,
    });
  }

  for (const doc of docs) {
    const ref = refs.find((r) => r.type !== "record" && r.entityId === doc.id)!;
    out.set(`${ref.type}:${doc.id}`, {
      type: ref.type,
      entityId: doc.id,
      title: doc.title,
      snippet: clip(ref.best.body),
      context: { kbId: doc.kb.id, kbName: doc.kb.name, docId: doc.id },
      matchedField: null,
    });
  }

  // 按 refs 输入顺序返回（调用方已按融合排序）；装配不到（实体已删）的不输出。
  return refs
    .map((r) => out.get(`${r.type}:${r.entityId}`))
    .filter((x): x is HydratedEntity => Boolean(x));
}
