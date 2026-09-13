// apps/api/scripts/bench/gen/insert.ts
// M1/S9：better-sqlite3 单连接事务批量直写【结构 + 数据 + sidecar】（不经 Prisma/cuid，
// 全确定性、可逐字节复现）：
//   - 身份/base/table/field/view：按 Shape.fieldDefs 直插，固定列默认值对齐生产建表；
//   - records：确定性 id（表前缀+序号）、createdAt=基准毫秒+时间桶（每 3 行同毫秒，压
//     keyset id tie-break）、部分软删；
//   - link_rows：children(mm) 多对多偏态、ownerLink(hm) 一对多（peer 至多属于一个 main）；
//     软删记录参与的关联同步标 deletedAt（贴生产删除语义）；
//   - record_field_index：policy.buildExpectedRows 单一事实源批量回填（仅活记录）。

import type Database from "better-sqlite3";
import { buildExpectedRows } from "../../../src/domain/fieldIndex/policy.js";
import { seqId } from "./prng.js";
import {
  BENCH_EMAIL,
  BENCH_PASSWORD_HASH,
  type FieldDef,
  type Shape,
} from "./schema.js";
import type { Rng } from "./prng.js";
import type { RowSpec } from "./rows.js";

const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
const BATCH = 5000;
/** 每多少条记录共享同一 createdAt 毫秒（制造大量同毫秒，压 id tie-break）。 */
const MS_BUCKET = 3;

/** 记录确定性 id：表语义前缀 + 定长 base36 序号（跨表唯一、零填充字典序==数值序）。 */
export function recId(prefix: string, i: number): string {
  return `${prefix}${(i + 1).toString(36).padStart(14, "0")}`;
}

function createdAtMs(i: number): number {
  return BASE_MS + Math.floor(i / MS_BUCKET);
}

export interface PopulateResult {
  live: number;
  softDeleted: number;
  linksMm: number;
  linksHm: number;
  sidecarRows: number;
}

interface IdRow { id: string; tableId: string; fields: string }

/** 写身份/base 成员（多 narrow 表共享同一 owner，仅插一次）。 */
export function insertIdentity(db: Database.Database, shape: Shape): void {
  // users.createdAt 显式给值：建表默认 CURRENT_TIMESTAMP 是墙钟，会破坏逐字节复现。
  const insUser = db.prepare(
    `INSERT INTO users (id,email,"displayName","passwordHash","createdAt") VALUES (?,?,?,?,?)`,
  );
  const insBase = db.prepare(
    `INSERT INTO bases (id,name,"iconColor","createdAt","createdBy") VALUES (?,?,?,?,?)`,
  );
  const insMember = db.prepare(
    `INSERT INTO members (id,"baseId","userId",role,"joinedAt") VALUES (?,?,?,?,?)`,
  );
  insUser.run(shape.ownerId, BENCH_EMAIL, "Bench Owner", BENCH_PASSWORD_HASH, BASE_MS);
  insBase.run(shape.baseId, "Bench Base", "#378ADD", BASE_MS, shape.ownerId);
  insMember.run(seqId("mbr"), shape.baseId, shape.ownerId, "owner", BASE_MS);
}

function insertTable(db: Database.Database, id: string, baseId: string, name: string, ownerId: string, primaryFieldId: string): void {
  db.prepare(
    `INSERT INTO tables (id,"baseId",name,"primaryFieldId","createdAt","createdBy","deletedAt")
     VALUES (?,?,?,?,?,?,NULL)`,
  ).run(id, baseId, name, primaryFieldId, BASE_MS, ownerId);
}

function insertField(db: Database.Database, d: FieldDef): void {
  // better-sqlite3 不绑定 boolean/undefined：布尔→0/1，undefined→null。
  const b = (x: unknown): number | string | bigint | Buffer | null => {
    if (typeof x === "boolean") return x ? 1 : 0;
    if (x === undefined) return null;
    return x as number | string | bigint | Buffer | null;
  };
  db.prepare(
    `INSERT INTO fields
      (id,"tableId",name,type,description,"order",required,"unique","deletedAt",options,"maxLength",
       "defaultNow",precision,"recordFilter","linkFieldId","relatedTableId","relationKind","isReverse",
       "reverseFieldId","linkDisplayFieldId","lookupFieldId","rollupFunction",formula,"tabsConfig",
       "displayedFieldIds","visibleFieldIds","defaultConfig","numberRule")
     VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ...([
      d.id, d.tableId, d.name, d.type, "", d.order, false, false,
      d.options, null,
      d.defaultNow, d.precision, d.recordFilter,
      d.linkFieldId, d.relatedTableId, d.relationKind, d.isReverse,
      d.reverseFieldId, d.linkDisplayFieldId, d.lookupFieldId,
      d.rollupFunction, d.formula, null,
      null, null, null, d.numberRule,
    ].map(b) as (number | string | bigint | Buffer | null)[]),
  );
}

function insertView(db: Database.Database, shape: Shape, tableId: string): void {
  db.prepare(
    `INSERT INTO views (id,"tableId",name,type,"lockMode","order",config,"createdAt")
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(shape.viewId, tableId, "Bench Grid", "grid", "collaborative", 0, "{}", BASE_MS);
}

function insertRecords(
  db: Database.Database,
  tableId: string,
  ownerId: string,
  rows: RowSpec[],
  prefix: string,
): { liveIds: string[]; deadIdx: Set<number> } {
  const ins = db.prepare(
    `INSERT INTO records (id,"tableId",fields,"createdAt","updatedAt","createdBy","updatedBy","deletedAt")
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const liveIds: string[] = [];
  const deadIdx = new Set<number>();
  const txn = db.transaction((specs: RowSpec[]) => {
    specs.forEach((r, idx) => {
      const id = recId(prefix, idx);
      const ms = createdAtMs(idx);
      const deleted = r.softDelete ? ms + 10 : null;
      ins.run(id, tableId, JSON.stringify(r.fields), ms, ms, ownerId, ownerId, deleted);
      if (r.softDelete) deadIdx.add(idx);
      else liveIds.push(id);
    });
  });
  for (let i = 0; i < rows.length; i += BATCH) txn(rows.slice(i, i + BATCH));
  return { liveIds, deadIdx };
}

function insertLinks(
  db: Database.Database,
  shape: Shape,
  mainRows: RowSpec[],
  peerRows: RowSpec[],
  mainDead: Set<number>,
  peerDead: Set<number>,
  rng: Rng,
  mainPrefix: string,
  peerPrefix: string,
): { mm: number; hm: number } {
  const mmField = shape.main.children!.id;
  const hmField = shape.main.ownerLink!.id;
  const ins = db.prepare(
    `INSERT INTO link_rows (id,"linkFieldId","parentRowId","childRowId",ord,"createdAt","deletedAt")
     VALUES (?,?,?,?,?,?,NULL)`,
  );
  let mm = 0;
  let hm = 0;
  const txn = db.transaction(() => {
    // hm 归属：每个活 peer 归一个【偏态】活 main（少量 main 挂大量 peer）。
    for (let pi = 0; pi < peerRows.length; pi++) {
      if (peerDead.has(pi)) continue;
      let owner = rng.skewedIndex(mainRows.length);
      let guard = 0;
      while (mainDead.has(owner) && guard++ < 64) owner = rng.skewedIndex(mainRows.length);
      if (mainDead.has(owner)) continue;
      ins.run(seqId("lr_h"), hmField, recId(mainPrefix, owner), recId(peerPrefix, pi), 0, BASE_MS + hm);
      hm++;
    }
    // mm 子项：每条活 main 连 0..6 个偏态 peer（唯一键去重）。
    for (let mi = 0; mi < mainRows.length; mi++) {
      if (mainDead.has(mi)) continue;
      const k = rng.int(0, 6);
      const chosen = new Set<number>();
      for (let t = 0; t < k; t++) chosen.add(rng.skewedIndex(peerRows.length));
      let ord = 0;
      for (const pi of chosen) {
        if (peerDead.has(pi)) continue;
        ins.run(seqId("lr_m"), mmField, recId("rec_m", mi), recId("rec_p", pi), ord++, BASE_MS + mm);
        mm++;
      }
    }
  });
  txn();
  // 软删记录参与的关联一并软删（贴生产：删记录时其 link_row 标 deletedAt）。
  db.prepare(
    `UPDATE link_rows SET "deletedAt" = ? WHERE "deletedAt" IS NULL AND
      ("parentRowId" IN (SELECT id FROM records WHERE "deletedAt" IS NOT NULL) OR
       "childRowId" IN (SELECT id FROM records WHERE "deletedAt" IS NOT NULL))`,
  ).run(BASE_MS + 999);
  return { mm, hm };
}

function tableDefs(shape: Shape, tableId: string): FieldDef[] {
  return shape.fieldDefs.filter((d) => d.tableId === tableId);
}

function primaryFieldId(shape: Shape, tableId: string): string {
  return tableId === shape.peerTableId ? shape.peer.title!.id : shape.main.title!.id;
}

function backfillSidecar(db: Database.Database, shape: Shape, tableId: string): number {
  const fields = tableDefs(shape, tableId);
  const pfId = primaryFieldId(shape, tableId);
  const ins = db.prepare(
    `INSERT INTO record_field_index ("recordId","tableId","fieldId","valueText","valueNum","isNull",ord)
     VALUES (?,?,?,?,?,?,?)`,
  );
  let total = 0;
  let lastId = "";
  for (;;) {
    const recs = db.prepare(
      `SELECT id,"tableId",fields FROM records
       WHERE "tableId"=? AND "deletedAt" IS NULL AND id > ? ORDER BY id LIMIT ?`,
    ).all(tableId, lastId, BATCH) as IdRow[];
    if (recs.length === 0) break;
    const expected = buildExpectedRows({
      primaryFieldId: pfId,
      fieldsMeta: fields.map((x) => ({ id: x.id, type: x.type })),
      records: recs.map((r) => ({ id: r.id, tableId: r.tableId, fields: r.fields })),
    });
    const txn = db.transaction((rows: typeof expected) => {
      for (const e of rows) ins.run(e.recordId, e.tableId, e.fieldId, e.valueText, e.valueNum, e.isNull, e.ord);
    });
    txn(expected);
    total += expected.length;
    lastId = recs[recs.length - 1]!.id;
    if (recs.length < BATCH) break;
  }
  return total;
}

/** 直写一整套结构+数据并回填 sidecar；返回清单计数。
 *  skipIdentity=true 时跳过 user/base/member 插入（narrow 多表共享同一 owner，仅首表插一次）。
 *  mainPrefix/peerPrefix 为记录 id 前缀（多 narrow 表须各异防撞 id；宽表固定 rec_m/rec_p）。 */
export function populate(
  db: Database.Database,
  shape: Shape,
  ownerId: string,
  gen: { mainRows: RowSpec[]; peerRows: RowSpec[]; rng: Rng },
  skipIdentity = false,
  mainPrefix = "rec_m",
  peerPrefix = "rec_p",
): PopulateResult {
  if (!skipIdentity) insertIdentity(db, shape);
  // 表（primaryFieldId 先占位空串，字段插完后更新——贴生产 createField 流程）。
  insertTable(db, shape.mainTableId, shape.baseId, shape.peerTableId ? "wide_main" : "narrow_main", ownerId, "");
  if (shape.peerTableId) {
    insertTable(db, shape.peerTableId, shape.baseId, "wide_peer", ownerId, "");
  }
  const txnFields = db.transaction((defs: FieldDef[]) => defs.forEach((d) => insertField(db, d)));
  // 分批插字段（宽表 30+ 字段一批即可，这里保守每 200 一批）。
  for (let i = 0; i < shape.fieldDefs.length; i += 200) txnFields(shape.fieldDefs.slice(i, i + 200));
  db.prepare(`UPDATE tables SET "primaryFieldId"=? WHERE id=?`).run(shape.main.title!.id, shape.mainTableId);
  if (shape.peerTableId) {
    db.prepare(`UPDATE tables SET "primaryFieldId"=? WHERE id=?`).run(shape.peer.title!.id, shape.peerTableId);
  }
  insertView(db, shape, shape.mainTableId);

  let sidecarRows = 0;
  const main = insertRecords(db, shape.mainTableId, ownerId, gen.mainRows, mainPrefix);
  let peerRows: RowSpec[] = [];
  let peerDead = new Set<number>();
  if (shape.peerTableId) {
    const pr = insertRecords(db, shape.peerTableId, ownerId, gen.peerRows, peerPrefix);
    peerDead = pr.deadIdx;
    peerRows = gen.peerRows;
  }
  const links = shape.peerTableId
    ? insertLinks(db, shape, gen.mainRows, peerRows, main.deadIdx, peerDead, gen.rng, mainPrefix, peerPrefix)
    : { mm: 0, hm: 0 };
  sidecarRows += backfillSidecar(db, shape, shape.mainTableId);
  if (shape.peerTableId) sidecarRows += backfillSidecar(db, shape, shape.peerTableId);

  return {
    live: main.liveIds.length,
    softDeleted: main.deadIdx.size,
    linksMm: links.mm,
    linksHm: links.hm,
    sidecarRows,
  };
}
