// M5/S12 损坏应急检索：search.db 损坏隔离+重建期间，当次检索回【主库】对 title/searchText
// 做参数化 LIKE（ADR-0049 / §4.9「search.db 损坏/打不开」行）。
//
// 安全口径（不放宽授权，不借应急路泄漏）：
//   - 候选只来自 M4 scope 已收敛的可见 nav 节点集（nodeIds）。scope 本身就是 r 决策结果，
//     应急路不再扩大候选，故无需也不应另做一次召回；它是"用主库 LIKE 顶替损坏的派生库召回"。
//   - 只匹配标题/正文主列：record 匹配其 primaryField 值（json_extract 路径参数绑定），
//     doc/canvas 匹配 kb_docs.title/searchText。绝不做全字段 LIKE。
//   - fieldMask fail-closed：若某可见表对本主体有 mask 且 primaryField 不在白名单，
//     该表整体不参与应急召回（标题本身即被 mask），宁可少召回也不泄漏被遮字段。
//   - 全程参数绑定（LIKE 模式、IN 列表、limit），无任何用户文本内插；IN 按 999 变量上限分批。
//   - 有界：固定 top20、limit<=50（与 §9 一致）。

import type { PrismaClient } from "@prisma/client";
import { escapeLikeLiteral } from "./queryPlan.js";
import type {
  DegradedReason,
  ScopeLike,
  UnifiedSearchItem,
  UnifiedSearchResponse,
} from "./queryTypes.js";

/** 应急 SQL 客户端最小形状（真实 PrismaClient 满足）。 */
interface EmergencyMainDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T[]>;
}

interface ScopeResource {
  type: "table" | "doc" | "canvas";
  id: string;
}

const IN_BATCH = 400; // 远低于 SQLite 999 变量上限（与同表其它绑定共享一条语句）。

/** 把 scope 的可见 nav 节点 id 映射回活资源（resourceType/resourceId），按批 IN 查 nav_nodes。 */
async function scopeResources(
  db: EmergencyMainDb,
  nodeIds: readonly string[],
): Promise<ScopeResource[]> {
  const rows: Array<{ resourceType: string | null; resourceId: string | null }> = [];
  for (let i = 0; i < nodeIds.length; i += IN_BATCH) {
    const chunk = nodeIds.slice(i, i + IN_BATCH);
    const placeholders = chunk.map(() => "?").join(",");
    const part = await db.$queryRawUnsafe<{ resourceType: string | null; resourceId: string | null }>(
      `SELECT resourceType, resourceId FROM nav_nodes
       WHERE deletedAt IS NULL AND resourceType IS NOT NULL AND resourceId IS NOT NULL
       AND id IN (${placeholders})`,
      ...chunk,
    );
    rows.push(...part);
  }
  const out: ScopeResource[] = [];
  for (const r of rows) {
    if (r.resourceType === "table" || r.resourceType === "doc" || r.resourceType === "canvas") {
      out.push({ type: r.resourceType, id: r.resourceId! });
    }
  }
  return out;
}

/** 取一批表的 primaryFieldId（用于 mask 表判定标题字段是否在白名单）。 */
async function primaryFieldIds(
  db: EmergencyMainDb,
  tableIds: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < tableIds.length; i += IN_BATCH) {
    const chunk = tableIds.slice(i, i + IN_BATCH);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.$queryRawUnsafe<{ id: string; primaryFieldId: string }>(
      `SELECT id, primaryFieldId FROM tables WHERE deletedAt IS NULL AND id IN (${placeholders})`,
      ...chunk,
    );
    for (const r of rows) map.set(r.id, r.primaryFieldId);
  }
  return map;
}

interface RecordRow {
  id: string;
  tableId: string;
  baseId: string;
  baseName: string;
  tableName: string;
  title: string | null;
}

/** 在可见且未被标题 mask 的表内，对 primaryField 值做参数化 LIKE。 */
async function searchRecords(
  db: EmergencyMainDb,
  tables: ReadonlyArray<{ nodeId: string; tableId: string }>,
  pattern: string,
  limit: number,
): Promise<RecordRow[]> {
  if (tables.length === 0) return [];
  const tableIds = tables.map((t) => t.tableId);
  const out: RecordRow[] = [];
  for (let i = 0; i < tableIds.length; i += IN_BATCH) {
    const chunk = tableIds.slice(i, i + IN_BATCH);
    const placeholders = chunk.map(() => "?").join(",");
    // json_extract 路径以绑定参数给出（'$.' || ?），primaryFieldId 不进 SQL 文本。
    const rows = await db.$queryRawUnsafe<RecordRow>(
      `SELECT r.id AS id, r.tableId AS tableId, b.id AS baseId, b.name AS baseName,
              t.name AS tableName,
              json_extract(r.fields, '$.' || t.primaryFieldId) AS title
       FROM records r
       JOIN tables t ON t.id = r.tableId AND t.deletedAt IS NULL
       JOIN bases b ON b.id = t.baseId AND b.deletedAt IS NULL
       WHERE r.deletedAt IS NULL AND r.tableId IN (${placeholders})
         AND json_extract(r.fields, '$.' || t.primaryFieldId) LIKE ? ESCAPE '\\'
       ORDER BY r.createdAt DESC
       LIMIT ?`,
      ...chunk,
      pattern,
      limit,
    );
    out.push(...rows);
  }
  return out
    .filter((r) => typeof r.title === "string" && r.title.length > 0)
    .sort((a, b) => (a.title! < b.title! ? -1 : a.title! > b.title! ? 1 : 0))
    .slice(0, limit);
}

interface DocRow {
  id: string;
  kbId: string;
  kbName: string;
  kind: string;
  title: string;
  searchText: string | null;
}

/** 对可见 doc/canvas 的 title/searchText 做参数化 LIKE。 */
async function searchDocs(
  db: EmergencyMainDb,
  docs: ReadonlyArray<{ type: "doc" | "canvas"; id: string }>,
  pattern: string,
  limit: number,
): Promise<UnifiedSearchItem[]> {
  if (docs.length === 0) return [];
  const ids = docs.map((d) => d.id);
  const rows: DocRow[] = [];
  for (let i = 0; i < ids.length; i += IN_BATCH) {
    const chunk = ids.slice(i, i + IN_BATCH);
    const placeholders = chunk.map(() => "?").join(",");
    const part = await db.$queryRawUnsafe<DocRow>(
      `SELECT d.id AS id, d.kbId AS kbId, k.name AS kbName, d.kind AS kind,
              d.title AS title, d.searchText AS searchText
       FROM kb_docs d
       JOIN knowledge_bases k ON k.id = d.kbId AND k.deletedAt IS NULL
       WHERE d.deletedAt IS NULL AND d.id IN (${placeholders})
         AND (d.title LIKE ? ESCAPE '\\' OR d.searchText LIKE ? ESCAPE '\\')
       ORDER BY d.updatedAt DESC
       LIMIT ?`,
      ...chunk,
      pattern,
      pattern,
      limit,
    );
    rows.push(...part);
  }
  return rows.slice(0, limit).map((d) => ({
    type: (d.kind === "canvas" ? "canvas" : "doc") as UnifiedSearchItem["type"],
    entityId: d.id,
    nodeId: `nav_${d.kind === "canvas" ? "canvas" : "doc"}_${d.id}`,
    title: d.title,
    snippet: clip(d.title),
    kbId: d.kbId,
    kbName: d.kbName,
    docId: d.id,
    score: 0,
    matchedVia: [],
    chunkSeq: null,
    matchedField: null,
  }));
}

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * 执行主库应急 LIKE（search.db 损坏重建期间的当次检索）。
 * @returns §9 同构响应：mode='like'，degraded 必含 search_store_recovering。
 */
export async function executeEmergencyLike(
  prisma: PrismaClient,
  scope: ScopeLike,
  query: string,
  limit: number,
  extraDegraded: DegradedReason[] = [],
): Promise<UnifiedSearchResponse> {
  const pattern = `%${escapeLikeLiteral(query)}%`;
  const resources = await scopeResources(prisma as unknown as EmergencyMainDb, scope.nodeIds);

  // fail-closed 标题 mask 判定：无 mask 行的表标题全可见；有 mask 的表仅当其 primaryField
  // 在白名单才允许以标题参与应急召回，否则整表跳过（标题本身即被遮，绝不泄漏）。
  const allTableIds = resources.filter((r) => r.type === "table").map((r) => r.id);
  const primaryOf = await primaryFieldIds(prisma as unknown as EmergencyMainDb, allTableIds);
  const tables = allTableIds
    .map((tableId) => {
      const nodeId = `nav_table_${tableId}`;
      const allow = scope.maskedTableFields[nodeId];
      if (allow === undefined) return { nodeId, tableId }; // 无 mask：全字段可见
      const primaryFieldId = primaryOf.get(tableId);
      if (primaryFieldId && allow.includes(primaryFieldId)) return { nodeId, tableId };
      return null; // 有 mask 且主字段不在白名单：跳过，宁少召回不泄漏
    })
    .filter((t): t is { nodeId: string; tableId: string } => t !== null);

  const docs = resources.filter((r): r is { type: "doc" | "canvas"; id: string } =>
    r.type === "doc" || r.type === "canvas");

  const [recordRows, docItems] = await Promise.all([
    searchRecords(prisma as unknown as EmergencyMainDb, tables, pattern, limit),
    searchDocs(prisma as unknown as EmergencyMainDb, docs, pattern, limit),
  ]);

  const recordItems: UnifiedSearchItem[] = recordRows.map((r) => ({
    type: "record",
    entityId: r.id,
    nodeId: `nav_table_${r.tableId}`,
    title: r.title!,
    snippet: clip(r.title!),
    baseId: r.baseId,
    baseName: r.baseName,
    tableId: r.tableId,
    tableName: r.tableName,
    score: 0,
    matchedVia: [],
    chunkSeq: null,
    matchedField: null,
  }));

  const items = [...recordItems, ...docItems]
    .sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0))
    .slice(0, limit);

  return {
    items,
    total: items.length,
    limit,
    mode: "like",
    degraded: Array.from(new Set<DegradedReason>(["search_store_recovering", ...extraDegraded])),
    scopeTruncated: scope.truncated,
    policyVersion: scope.policyVersion,
  };
}
