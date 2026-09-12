// apps/api/scripts/bench/backfill-sidecar.ts
// M1/S4 sidecar 幂等回填（可重跑，低峰执行；跑期间读路径 GX_M1_SIDECAR 不影响，本片只读不接查询）。
//
// 用法：
//   DATABASE_URL=file:/path/app.db pnpm tsx scripts/bench/backfill-sidecar.ts [--table <id>] [--batch 1000]
//
// 策略：逐表、id > lastId 游标分批拉【活记录】→ policy.buildExpectedRows 算期望行
//   → 同一批事务内先按 recordId 幂等删旧、再批量插新（先删后插，唯一键不冲突）。
// 扫完后清理该表孤儿 sidecar 行（recordId 已非活记录：软删历史残留/物理删外的极端情况）。
// 不把全表放进单一大事务（避免百万行锁库）；中断后重跑仍收敛到 drift=0。

import {
  openDb,
  loadTableMetas,
  nextRecordBatch,
  expectedFor,
  type TableMeta,
} from "./sidecar-lib.js";

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const onlyTable = argValue("--table", "");
const batch = Math.max(1, Number(argValue("--batch", "1000")) || 1000);
const db = openDb(false);

function backfillTable(meta: TableMeta): { records: number; rows: number; orphans: number } {
  let lastId = "";
  let records = 0;
  let rows = 0;

  // 显式占位符按批大小预分配；末批不足用 null 补齐（recordId 永不为 NULL，安全）。
  const del = db.prepare(
    `DELETE FROM record_field_index WHERE "recordId" IN (${Array.from({ length: batch }, () => "?").join(",")})`,
  );
  const insert = db.prepare(
    `INSERT INTO record_field_index ("recordId","tableId","fieldId","valueText","valueNum","isNull","ord")
     VALUES (?,?,?,?,?,?,?)`,
  );

  for (;;) {
    const recs = nextRecordBatch(db, meta.tableId, lastId, batch);
    if (recs.length === 0) break;
    const expected = expectedFor(meta, recs);
    const ids = recs.map((r) => r.id);
    const txn = db.transaction(() => {
      // 占位符按批大小预分配，末批用 null 补齐（多余 ? 绑定 NULL，recordId 不会等于 NULL）。
      del.run(...Array.from({ length: batch }, (_, i) => ids[i] ?? null));
      for (const e of expected) {
        insert.run(e.recordId, e.tableId, e.fieldId, e.valueText, e.valueNum, e.isNull, e.ord);
      }
    });
    txn();
    records += recs.length;
    rows += expected.length;
    lastId = recs[recs.length - 1]!.id;
    if (recs.length < batch) break;
  }

  // 清孤儿：sidecar 里挂在本表、但源记录已非活（软删/不存在）的行。
  const orphanInfo = db
    .prepare(
      `DELETE FROM record_field_index
       WHERE "tableId" = ? AND "recordId" NOT IN
         (SELECT id FROM records WHERE "tableId" = ? AND "deletedAt" IS NULL)`,
    )
    .run(meta.tableId, meta.tableId);
  return { records, rows, orphans: orphanInfo.changes };
}

const metas = loadTableMetas(db, onlyTable || undefined);
if (metas.length === 0) {
  console.error(`未找到表${onlyTable ? `：${onlyTable}` : "（库中无活表）"}`);
  process.exit(1);
}

let totalRecords = 0;
let totalRows = 0;
let totalOrphans = 0;
for (const meta of metas) {
  const r = backfillTable(meta);
  totalRecords += r.records;
  totalRows += r.rows;
  totalOrphans += r.orphans;
  console.log(
    `table=${meta.tableId} records=${r.records} sidecarRows=${r.rows} orphanRemoved=${r.orphans}`,
  );
}
console.log(
  JSON.stringify({ tables: metas.length, records: totalRecords, sidecarRows: totalRows, orphanRemoved: totalOrphans, batch }),
);
db.close();
