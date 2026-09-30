// M5/S5 实体抽取：从主库（Prisma）取活实体 -> 复用 S3 chunks.ts 纯函数产出 chunk 描述。
//
// 权威依据：M5-implementation-plan §4.6（三族内容与 chunk 策略）、§5.3（取实体活/删）。
// 边界：
//   - 只读主库；不写 search.db（写入在 indexerDerive.ts）、不发网络、不 import db 单例
//     （仅 type-only PrismaClient，运行期由 indexer 注入 h.prisma，规避测试收集期连错库）。
//   - doc 去标记复用 domain/kb.markdownToSearchText：该模块顶层静态 import db 单例，故此处
//     采用【用时动态 import】（同 nav sync 模式），保证本模块被 vitest 收集时不产生连接。
//   - record 走 buildRecordChunks（identity 无业务值 + 确定性取舍的 field chunk）；
//     doc 先 h1-h3 粗切、每节去标记后再滑窗（落地 S3 advisory#2：真实去标记）；
//     canvas 用 buildCanvasIdentityChunks（S3 已按元素遍历，非全板一串）。

import type { PrismaClient } from "@prisma/client";
import {
  buildRecordChunks,
  splitMarkdownHeadings,
  windowText,
  type ProducedChunk,
  type ChunkEntityType,
} from "./chunks.js";
import { buildCanvasIdentityChunks } from "./chunks-canvas.js";
import { extractMarkdownImages } from "./image-extract.js";
import { FIELD_CHUNK_CAP, DOC_TARGET_MAX, DOC_OVERLAP } from "./chunks.js";

/** nav 节点 id 与 domain/nav/backfill.nodeId 保持同一形态 nav_<kind>_<resourceId>（本地镜像，避免跨域静态依赖）。 */
export function navNodeId(kind: "table" | "doc" | "canvas", resourceId: string): string {
  return `nav_${kind}_${resourceId}`;
}

export interface ExtractedEntity {
  entityType: ChunkEntityType;
  entityId: string;
  /** false=实体不存在/已软删/父表已删：调用方走 delete 清派生行。 */
  present: boolean;
  chunks: ProducedChunk[];
  /** record 因超 N 被截断（用于 index_meta.capped_records 累加）。 */
  fieldCapped: boolean;
  /** 内容版本（写 chunks.version；record=事件 ms，doc=contentVersion）。 */
  version: number;
}

type MainClient = PrismaClient;

function parseFields(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function extractRecord(
  prisma: MainClient,
  entityId: string,
  version: number,
  cap: number,
): Promise<ExtractedEntity> {
  const rec = await prisma.record.findUnique({ where: { id: entityId } });
  if (!rec || rec.deletedAt) return gone("record", entityId, version);
  const table = await prisma.table.findUnique({ where: { id: rec.tableId } });
  if (!table || table.deletedAt) return gone("record", entityId, version);
  const base = await prisma.base.findUnique({ where: { id: table.baseId } });
  if (!base || base.deletedAt) return gone("record", entityId, version);

  const fieldDefs = await prisma.field.findMany({
    where: { tableId: table.id, deletedAt: null },
    select: { id: true, name: true, type: true, order: true },
  });
  const values = parseFields(rec.fields);
  const fields = fieldDefs.map((f) => ({
    fieldId: f.id,
    name: f.name,
    type: f.type,
    order: f.order,
    value: values[f.id],
  }));

  const built = buildRecordChunks(
    {
      recordId: rec.id,
      tableNodeId: navNodeId("table", table.id),
      tableName: table.name,
      baseName: base.name,
      primaryFieldId: table.primaryFieldId,
      fields,
    },
    cap,
  );
  return {
    entityType: "record", entityId, present: true,
    chunks: built.chunks, fieldCapped: built.meta.capped, version,
  };
}

/**
 * doc：h1-h3 粗切 -> 每节 markdownToSearchText 去标记 -> 超长滑窗；标题路径进 title。
 * 落地 S3 advisory#2：buildDocChunksFromMarkdown 的纯切骨架在此接上真实去标记。
 */
async function buildDocChunks(
  docId: string,
  nodeId: string,
  title: string,
  markdown: string,
): Promise<ProducedChunk[]> {
  const { markdownToSearchText } = await import("../kb.js");
  const out: ProducedChunk[] = [];
  // #563：整篇文档图片提取一次，挂到首个 chunk（图片无章节归属，先保证全部入索引）。
  const docImages = extractMarkdownImages(markdown);
  for (const section of splitMarkdownHeadings(markdown)) {
    const plain = markdownToSearchText(section.text);
    for (const w of windowText(plain, DOC_TARGET_MAX, DOC_OVERLAP)) {
      const path = section.headingPath.join(" / ");
      const isFirst = out.length === 0;
      out.push({
        chunkKind: "identity",
        chunkId: `doc:${docId}:${out.length}`,
        entityType: "doc",
        entityId: docId,
        nodeId,
        fieldId: null,
        title: path ? `${title} / ${path}` : title,
        body: w,
        seq: out.length,
        ...(isFirst && docImages.length > 0 ? { images: docImages } : {}),
      });
    }
  }
  return out;
}

function identityFallback(
  type: ChunkEntityType,
  entityId: string,
  nodeId: string,
  title: string,
  body: string,
): ProducedChunk[] {
  // 空文档/无文本画布：保一个 title-only identity，使覆盖度 A 不把"存在但无正文"误判为漏索引。
  return [{
    chunkKind: "identity",
    chunkId: `${type}:${entityId}:0`,
    entityType: type, entityId, nodeId, fieldId: null,
    title, body, seq: 0,
  }];
}

async function extractDocOrCanvas(
  prisma: MainClient,
  type: "doc" | "canvas",
  entityId: string,
  version: number,
): Promise<ExtractedEntity> {
  const doc = await prisma.kbDoc.findUnique({ where: { id: entityId } });
  if (!doc || doc.deletedAt || doc.kind !== type) return gone(type, entityId, version);
  const nodeId = navNodeId(type, entityId);
  let chunks: ProducedChunk[];
  if (type === "doc") {
    chunks = await buildDocChunks(entityId, nodeId, doc.title, doc.content);
    if (chunks.length === 0) chunks = identityFallback("doc", entityId, nodeId, doc.title, doc.searchText);
  } else {
    const built = buildCanvasIdentityChunks({ canvasId: entityId, nodeId, title: doc.title, contentJson: doc.content });
    chunks = built && built.chunks.length > 0
      ? built.chunks
      : identityFallback("canvas", entityId, nodeId, doc.title, doc.searchText);
  }
  return { entityType: type, entityId, present: true, chunks, fieldCapped: false, version };
}

function gone(type: ChunkEntityType, entityId: string, version: number): ExtractedEntity {
  return { entityType: type, entityId, present: false, chunks: [], fieldCapped: false, version };
}

/**
 * 抽取一个事件对应实体的当前活内容。op 不影响取数：upsert 时实体已删也回落为清理（present=false）。
 * @param cap record field chunk 软上限（默认 50，来自 env/app_settings）。
 */
export async function extractEntity(
  prisma: MainClient,
  event: { entityType: string; entityId: string; version: bigint },
  cap: number = FIELD_CHUNK_CAP,
): Promise<ExtractedEntity> {
  const version = Number(event.version);
  if (event.entityType === "record") return extractRecord(prisma, event.entityId, version, cap);
  if (event.entityType === "doc") return extractDocOrCanvas(prisma, "doc", event.entityId, version);
  if (event.entityType === "canvas") return extractDocOrCanvas(prisma, "canvas", event.entityId, version);
  // 未知族：保守按"缺席"清理，不抛（避免单条坏事件卡死队列）。
  return gone(event.entityType as ChunkEntityType, event.entityId, version);
}
