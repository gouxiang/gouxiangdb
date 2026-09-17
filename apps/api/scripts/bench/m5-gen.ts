// apps/api/scripts/bench/m5-gen.ts
// M5/S13 规模数据生成：向独立 search.db 直接写入生产同构的 chunks/fts_chunks/vec_chunks（真 vec0）。
//
// 内存纪律（2C4G 关键）：**分批写入、绝不把全量行/向量堆在内存**。每批 BATCH 行一个写事务；
// 向量在写入批次内逐行生成（deterministicVector 由 rowid 纯函数导出，非 rng，故与插入顺序无关、
// 可复现），生成后即落盘释放。文本按确定种子生成，保证同 --seed 逐字节可复现。
//
// 复现口径：三族按 §4.6 内容比例（record 60% / doc 30% / canvas 10%）；record 每实体 1 identity
// + F 个 field chunk（宽表拆分）；doc/canvas 每实体 1..K 个 identity chunk。scope 节点集 = 全部
// 生成节点（真机可测"全 scope 最坏 JOIN"）。

import path from "node:path";
import fs from "node:fs";
import { openSearchStore } from "../../src/domain/search/searchStore.js";
import { vecBlob } from "../../src/domain/search/vecLoader.js";
import { Rng } from "./gen/prng.js";
import { planFamilyMix, type BenchFamily } from "./m5-bench-lib.js";

const VOCAB = [
  "季度报告", "项目计划", "客户清单", "预算表", "会议纪要", "设计稿", "需求文档", "上线公告",
  "复盘总结", "里程碑", "风险评估", "值班表", "合同", "发票", "路线图", "调研笔记",
  "确定性的检索命中词", "宽表字段值", "画布元素文本", "知识库文档正文",
];

/** 由 rowid 纯函数导出单位向量（与插入顺序无关，可复现；L2 距离因此有可比语义）。 */
export function deterministicVector(rowid: number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  let s = (rowid * 2654435761) >>> 0;
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const f = (s % 20000) / 10000 - 1; // [-1,1)
    v[i] = f;
    norm += f * f;
  }
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 1;
  for (let i = 0; i < dim; i++) v[i]! *= inv;
  return v;
}

/** 确定性查询向量（与库内向量同分布族；用固定 seed 使跨机可比）。 */
export function queryVector(seed: number, dim: number): Float32Array {
  return deterministicVector(seed ^ 0x9e3779b9, dim);
}

export interface GenOptions {
  filePath: string;
  appDir: string;
  totalChunks: number;
  dim: number;
  seed: number;
  batchSize?: number;
  /** 每 record 的 field chunk 数（宽表拆分度）。 */
  fieldChunksPerRecord?: number;
  /** 每 N 张表标记为"有字段 mask"并写 field_grant 行（0=不写，测无 mask 快路径）。 */
  maskEveryNthTable?: number;
}

export interface GenResult {
  totalChunks: number;
  families: Record<BenchFamily, number>;
  dim: number;
  nodeIds: string[];
  entityCounts: Record<BenchFamily, number>;
  grantRows: number;
  dbBytes: number;
  buildMs: number;
}

interface ChunkRow {
  rowid: number;
  entityType: BenchFamily;
  entityId: string;
  nodeId: string;
  chunkKind: "identity" | "field";
  fieldId: string | null;
  title: string;
  body: string;
  seq: number;
}

function sentence(rng: Rng, min: number, max: number, withTerm: boolean): string {
  const n = rng.int(min, max);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(rng.pick(VOCAB));
  if (withTerm) parts.push("季度报告"); // 保证 FTS 有命中（三路召回都非空）
  return parts.join(" ");
}

/**
 * 生成并写入一个 search.db。分批写入；返回 nodeIds（scope 集）与统计。
 * 抛错时清理半成品文件由调用方负责（gate 会 rm 目录）。
 */
export async function generateSearchDb(opts: GenOptions): Promise<GenResult> {
  const t0 = Date.now();
  const batch = opts.batchSize ?? 2000;
  const F = opts.fieldChunksPerRecord ?? 20; // 宽表：每 record 20 个字段 chunk
  const maskEvery = opts.maskEveryNthTable ?? 10;
  const rng = new Rng(opts.seed);
  const targets = planFamilyMix(opts.totalChunks);

  const store = openSearchStore({ filePath: opts.filePath, appDir: opts.appDir, tryLoadVec: true });
  if (!store.ensureVecChunks(opts.dim)) {
    store.close();
    throw new Error(`vec0 不可用（dim=${opts.dim}）：${store.vecError ?? "unknown"}；请检查 glibc/arch 与 sqlite-vec 平台包`);
  }

  const nodeIds = new Set<string>();
  const families: Record<BenchFamily, number> = { record: 0, doc: 0, canvas: 0 };
  const entityCounts: Record<BenchFamily, number> = { record: 0, doc: 0, canvas: 0 };
  let rowid = 0;
  let grantRows = 0;

  const insChunk = store.db.prepare(
    `INSERT INTO chunks(rowid,chunkId,entityType,entityId,nodeId,workspaceId,chunkKind,fieldId,title,seq,version,length,updatedAt)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insFts = store.db.prepare(
    "INSERT INTO fts_chunks(rowid, title, body, chunkId, nodeId, entityType) VALUES(?,?,?,?,?,?)",
  );
  const insVec = store.db.prepare("INSERT INTO vec_chunks(rowid, embedding, entityType) VALUES(?,?,?)");
  const insGrant = store.db.prepare("INSERT INTO field_grant(chunkRowid, tableNodeId, fieldId) VALUES(?,?,?)");

  let buf: ChunkRow[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    const rows = buf;
    buf = [];
    store.writeTxn("m5-gen", () => {
      for (const r of rows) {
        insChunk.run(
          BigInt(r.rowid), `chk_${r.rowid}`, r.entityType, r.entityId, r.nodeId, "ws_default",
          r.chunkKind, r.fieldId, r.title, r.seq, 0, r.body.length, "2026-09-17T00:00:00.000Z",
        );
        insFts.run(BigInt(r.rowid), r.title, r.body, `chk_${r.rowid}`, r.nodeId, r.entityType);
        insVec.run(BigInt(r.rowid), vecBlob(deterministicVector(r.rowid, opts.dim)), BigInt(
          r.entityType === "record" ? 1 : r.entityType === "doc" ? 2 : 3,
        ));
      }
    });
  };

  const push = (row: Omit<ChunkRow, "rowid">): void => {
    rowid += 1;
    buf.push({ rowid, ...row });
    nodeIds.add(row.nodeId);
    families[row.entityType] += 1;
    if (buf.length >= batch) flush();
  };

  // ---- record：每实体 1 identity + F field chunk（宽表拆分）；200 条/表 ----
  const recordsPerTable = 200;
  const chunksPerTable = recordsPerTable * (1 + F);
  const tableCount = Math.max(1, Math.ceil(targets.record / chunksPerTable));
  let rec = 0;
  while (families.record < targets.record) {
    const recordIdx = rec;
    const tableId = `tbl_${recordIdx % tableCount}`;
    const nodeId = `nav_table_${tableId}`;
    const recordId = `rec_${recordIdx}`;
    const masked = maskEvery > 0 && (recordIdx % tableCount) % maskEvery === 0;
    const remaining = targets.record - families.record;
    const emit = Math.min(1 + F, remaining);
    push({
      entityType: "record", entityId: recordId, nodeId, chunkKind: "identity", fieldId: null,
      title: recordId, body: sentence(rng, 3, 6, false), seq: 0,
    });
    for (let k = 0; k < emit - 1; k++) {
      const fieldId = `${recordId}_f${k}`;
      push({
        entityType: "record", entityId: recordId, nodeId, chunkKind: "field", fieldId,
        title: `字段${k}`, body: sentence(rng, 4, 10, k === 0), seq: k + 1,
      });
      // 有 mask 的表：仅前一半字段授予（制造三分支白名单，测收敛子查询成本）。
      if (masked && k < Math.ceil(F / 2)) {
        insGrant.run(BigInt(rowid), nodeId, fieldId);
        grantRows += 1;
      }
    }
    entityCounts.record += 1;
    rec += 1;
  }

  // ---- doc：每实体 1..4 identity chunk ----
  let doc = 0;
  while (families.doc < targets.doc) {
    const docId = `doc_${doc}`;
    const nodeId = `nav_doc_${docId}`;
    const n = Math.min(rng.int(1, 4), targets.doc - families.doc);
    for (let i = 0; i < n; i++) {
      push({
        entityType: "doc", entityId: docId, nodeId, chunkKind: "identity", fieldId: null,
        title: i === 0 ? `文档${doc}` : `文档${doc} #${i}`, body: sentence(rng, 5, 12, doc % 20 === 0), seq: i,
      });
    }
    entityCounts.doc += 1;
    doc += 1;
  }

  // ---- canvas：每实体 1..6 identity chunk ----
  let canvas = 0;
  while (families.canvas < targets.canvas) {
    const canvasId = `cv_${canvas}`;
    const nodeId = `nav_canvas_${canvasId}`;
    const n = Math.min(rng.int(1, 6), targets.canvas - families.canvas);
    for (let i = 0; i < n; i++) {
      push({
        entityType: "canvas", entityId: canvasId, nodeId, chunkKind: "identity", fieldId: null,
        title: i === 0 ? `画布${canvas}` : `画布${canvas} #${i}`, body: sentence(rng, 3, 8, canvas % 30 === 0), seq: i,
      });
    }
    entityCounts.canvas += 1;
    canvas += 1;
  }
  flush();

  store.db.pragma("wal_checkpoint(TRUNCATE)");
  const dbBytes = fs.existsSync(opts.filePath) ? fs.statSync(opts.filePath).size : 0;
  store.close();
  return {
    totalChunks: rowid, families, dim: opts.dim, nodeIds: [...nodeIds],
    entityCounts, grantRows, dbBytes, buildMs: Date.now() - t0,
  };
}

/** 默认 db 路径（dataDir/m5-<label>/search.db）。 */
export function defaultDbPath(dataDir: string, label: string): string {
  return path.join(dataDir, `m5-${label}`, "search.db");
}
