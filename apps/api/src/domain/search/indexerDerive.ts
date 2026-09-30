// M5/S5 search.db 派生写入：把抽取产物落 chunks/fts/field_grant/vec_chunks，并负责删除联动。
//
// 权威依据：M5-implementation-plan §5.3（删旧->取新 rowid->写；cloud embed->写 vec）、
// §4.2（rowid 三处对齐、BigInt、Float32 BLOB）、§4.4/§4.9（FTS 优先、向量欠账不阻断）。
//
// 两阶段（关键语义）：
//   阶段1（一个写事务）：按 entityId 删旧四表派生行 -> allocateRowId 取新号 ->
//                       写 chunks/fts_chunks/field_grant，提交。FTS 立即可搜。
//   阶段2（网络在事务外）：cloud 且 vec0 可用时 provider.embed(bodies)，成功后第二个写事务
//                       写 vec_chunks；embed 失败/dim 不符 -> 不抛、记 vecDebt（§4.9：
//                       cloud 故障期 FTS done，向量欠账由 check-coverage D 类补发）。
// 网络调用绝不持有 search.db 写事务，避免长占锁。

import type { SearchStore } from "./searchStore.js";
import { META_KEYS, getMeta, setMeta, entityTypeCode } from "./schema.js";
import { vecInt, vecBlob } from "./vecLoader.js";
import type { EmbeddingProvider } from "./embedding/types.js";
import type { ProducedChunk } from "./chunks.js";
import type { ExtractedEntity } from "./entityExtract.js";

export interface DeriveSummary {
  chunksWritten: number;
  fieldGrants: number;
  vecWritten: number;
  /** cloud 模式下应写但本轮没写成的向量数（embed 失败/dim 不符/vec0 不可用不计欠账）。 */
  vecDebt: number;
  /** 本轮该实体 record 字段超 N 被截断（调用方据此累加 capped_records）。 */
  fieldCapped: boolean;
  dimMismatch: boolean;
}

interface PreparedRow {
  rowid: bigint;
  chunk: ProducedChunk;
  /** 送向量化的文本：body 空时回退 title（避免零长向量无法落 float[D]）。 */
  embedText: string;
  /** 随该行向量化的图片（#563）。 */
  images: string[];
}

/** vec_chunks 仅在 cloud 首次成功 embed 后才建（§4.2）；fts-only/off 形态下不存在，删前必判。 */
function vecChunksPresent(tx: SearchStore["db"]): boolean {
  return tx
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
    .get() !== undefined;
}

/** 删一个 rowid 在 fts/vec/field_grant 的派生行；vec 表不存在时跳过（off/fts-only 常态）。 */
function deleteChildRows(tx: SearchStore["db"], id: bigint): void {
  tx.prepare("DELETE FROM fts_chunks WHERE rowid = ?").run(id);
  if (vecChunksPresent(tx)) tx.prepare("DELETE FROM vec_chunks WHERE rowid = ?").run(id);
  tx.prepare("DELETE FROM field_grant WHERE chunkRowid = ?").run(id);
}

/** 删除一个实体在四表的全部派生行（chunks.rowid 联动 fts/vec/field_grant）。返回删除 chunk 数。 */
export function deleteDerived(store: SearchStore, entityType: string, entityId: string): number {
  return store.writeTxn(`delete-derived:${entityType}:${entityId}`, (tx) => {
    const rows = tx
      .prepare("SELECT rowid FROM chunks WHERE entityType = ? AND entityId = ?")
      .all(entityType, entityId) as Array<{ rowid: number | bigint }>;
    const ids = rows.map((r) => vecInt(r.rowid));
    for (const id of ids) deleteChildRows(tx, id); // 逐条参数化（单实体派生行有界；rowid 全 bigint）
    tx.prepare("DELETE FROM chunks WHERE entityType = ? AND entityId = ?").run(entityType, entityId);
    return ids.length;
  });
}

/** 阶段1：删旧 + 写 chunks/fts/field_grant（一个写事务），返回带新 rowid 的行供阶段2向量化。 */
function writeBaseRows(
  store: SearchStore,
  entity: ExtractedEntity,
  workspaceId: string,
  updatedAt: string,
): PreparedRow[] {
  return store.writeTxn(`upsert-base:${entity.entityType}:${entity.entityId}`, (tx) => {
    // 先删旧（再编辑/恢复先删后建，不产生重复 chunkId/rowid）。
    const old = tx
      .prepare("SELECT rowid FROM chunks WHERE entityType = ? AND entityId = ?")
      .all(entity.entityType, entity.entityId) as Array<{ rowid: number | bigint }>;
    for (const r of old) deleteChildRows(tx, vecInt(r.rowid));
    tx.prepare("DELETE FROM chunks WHERE entityType = ? AND entityId = ?")
      .run(entity.entityType, entity.entityId);

    const insChunk = tx.prepare(
      `INSERT INTO chunks(rowid,chunkId,entityType,entityId,nodeId,workspaceId,chunkKind,fieldId,title,seq,version,length,updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insFts = tx.prepare(
      "INSERT INTO fts_chunks(rowid,title,body,chunkId,nodeId,entityType) VALUES(?,?,?,?,?,?)",
    );
    const insGrant = tx.prepare(
      "INSERT INTO field_grant(chunkRowid,tableNodeId,fieldId) VALUES(?,?,?)",
    );

    const prepared: PreparedRow[] = [];
    for (const chunk of entity.chunks) {
      const rowid = store.allocateRowId(tx); // 三处对齐的唯一 bigint 号
      insChunk.run(
        rowid, chunk.chunkId, chunk.entityType, chunk.entityId, chunk.nodeId, workspaceId,
        chunk.chunkKind, chunk.fieldId, chunk.title, chunk.seq, entity.version,
        Buffer.byteLength(chunk.body, "utf8"), updatedAt,
      );
      insFts.run(rowid, chunk.title, chunk.body, chunk.chunkId, chunk.nodeId, chunk.entityType);
      if (chunk.chunkKind === "field" && chunk.fieldId) {
        insGrant.run(rowid, chunk.nodeId, chunk.fieldId); // nodeId=tableNodeId（record）
      }
      prepared.push({
        rowid,
        chunk,
        embedText: chunk.body.trim() || chunk.title,
        images: chunk.images ?? [],
      });
    }
    return prepared;
  });
}

/** 阶段2：embed 后第二个写事务写 vec_chunks（Float32 BLOB + bigint entityType）。 */
function writeVectors(store: SearchStore, rows: PreparedRow[], vectors: Float32Array[]): number {
  return store.writeTxn("upsert-vec", (tx) => {
    const ins = tx.prepare("INSERT INTO vec_chunks(rowid, embedding, entityType) VALUES(?,?,?)");
    let n = 0;
    rows.forEach((r, i) => {
      const v = vectors[i];
      if (!v || v.length === 0) return; // 零长不写（计入欠账由调用方统计）
      ins.run(r.rowid, vecBlob(v), entityTypeCode(r.chunk.entityType));
      n += 1;
    });
    return n;
  });
}

export interface UpsertOptions {
  workspaceId: string;
  mode: "off" | "cloud";
  provider: EmbeddingProvider | null;
  now?: () => Date;
}

/**
 * 把一个活实体的抽取结果派生进 search.db。FTS/授权先落库；向量尽力而为。
 * 不抛向量错误（FTS 可用性优先）；仅在基础写事务失败时抛出（那是真损坏，应触发事件重试）。
 */
export async function applyUpsert(
  store: SearchStore,
  entity: ExtractedEntity,
  opts: UpsertOptions,
): Promise<DeriveSummary> {
  const now = opts.now ?? (() => new Date());
  const rows = writeBaseRows(store, entity, opts.workspaceId, now().toISOString());
  const fieldGrants = rows.filter((r) => r.chunk.chunkKind === "field").length;

  if (entity.fieldCapped) incrementCapped(store);

  const summary: DeriveSummary = {
    chunksWritten: rows.length, fieldGrants, vecWritten: 0, vecDebt: 0,
    fieldCapped: entity.fieldCapped, dimMismatch: false,
  };

  const wantVec = opts.mode === "cloud" && opts.provider && store.vecAvailable;
  if (!wantVec || rows.length === 0) return summary;

  try {
    // #563：provider 支持多模态时图片随条目一起向量化；否则回退纯文本（老行为不变）。
    const anyImages = rows.some((r) => r.images.length > 0);
    let vectors: Float32Array[];
    if (anyImages && opts.provider!.embedMultimodal) {
      vectors = await opts.provider!.embedMultimodal(
        rows.map((r) => ({ text: r.embedText, images: r.images })),
      );
    } else {
      vectors = await opts.provider!.embed(rows.map((r) => r.embedText));
    }
    const dim = vectors.find((v) => v && v.length > 0)?.length ?? 0;
    if (dim > 0) {
      const existing = getMeta(store.db, META_KEYS.embeddingDim);
      if (existing && Number(existing) !== dim) {
        summary.dimMismatch = true; // model/dim 变更未 reindex（S9），本轮不写向量
        summary.vecDebt = rows.length;
        return summary;
      }
      store.ensureVecChunks(dim);
      summary.vecWritten = writeVectors(store, rows, vectors);
      summary.vecDebt = rows.length - summary.vecWritten;
    } else {
      summary.vecDebt = rows.length; // 全空响应：欠账
    }
  } catch {
    // cloud 401/故障/超时：FTS 已成功落库，向量记欠账待 check-coverage D 补发（§4.9）。
    summary.vecDebt = rows.length;
  }
  return summary;
}

/** capped_records 计数 +1（超 N 截断的实体数，§4.6）。独立短事务。 */
function incrementCapped(store: SearchStore): void {
  store.writeTxn("meta-capped", (tx) => {
    const cur = Number(getMeta(tx, META_KEYS.cappedRecords) ?? "0");
    setMeta(tx, META_KEYS.cappedRecords, String(cur + 1));
  });
}
