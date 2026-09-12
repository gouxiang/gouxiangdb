// apps/api/scripts/bench/check-sidecar.ts
// M1/S4 sidecar 只读巡检：逐表、分批把「fields JSON 期望行」与「record_field_index 实际行」
// 对拍，报告 drift（缺失/多余/值不一致）与孤儿行。drift=0 才退出 0，否则退出 1（CI/上线闸可用）。
//
// 用法：
//   DATABASE_URL=file:/path/app.db pnpm tsx scripts/bench/check-sidecar.ts [--table <id>] [--batch 1000] [--sample-limit 20]

import {
  openDb,
  loadTableMetas,
  nextRecordBatch,
  expectedFor,
  fetchActualRows,
  rowKey,
  valueEqual,
  type TableMeta,
} from "./sidecar-lib.js";

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const onlyTable = argValue("--table", "");
const batch = Math.max(1, Number(argValue("--batch", "1000")) || 1000);
const sampleLimit = Number(argValue("--sample-limit", "20")) || 20;
const db = openDb(true);

interface TableDrift {
  tableId: string;
  expected: number;
  actualForLive: number;
  missing: number;
  extra: number;
  mismatch: number;
  orphans: number;
  samples: string[];
}

function checkTable(meta: TableMeta): TableDrift {
  let lastId = "";
  let expected = 0;
  let actualForLive = 0;
  let missing = 0;
  let extra = 0;
  let mismatch = 0;
  const samples: string[] = [];
  const pushSample = (s: string) => {
    if (samples.length < sampleLimit) samples.push(s);
  };

  for (;;) {
    const recs = nextRecordBatch(db, meta.tableId, lastId, batch);
    if (recs.length === 0) break;
    const expRows = expectedFor(meta, recs);
    const expByKey = new Map(expRows.map((e) => [rowKey(e), e]));
    const actRows = fetchActualRows(db, recs.map((r) => r.id));
    const actByKey = new Map(actRows.map((a) => [rowKey(a), a]));
    expected += expRows.length;
    actualForLive += actRows.length;

    for (const [key, e] of expByKey) {
      const a = actByKey.get(key);
      if (!a) {
        missing += 1;
        pushSample(`missing ${key}`);
      } else if (!valueEqual(a, e)) {
        mismatch += 1;
        pushSample(`mismatch ${key} actual(t=${a.valueText},n=${a.valueNum},null=${a.isNull}) exp(t=${e.valueText},n=${e.valueNum},null=${e.isNull})`);
      }
    }
    for (const key of actByKey.keys()) {
      if (!expByKey.has(key)) {
        extra += 1;
        pushSample(`extra ${key}`);
      }
    }
    lastId = recs[recs.length - 1]!.id;
    if (recs.length < batch) break;
  }

  // 孤儿：sidecar 中本表记录源已非活（软删/不存在）的行。
  const orphans = (
    db
      .prepare(
        `SELECT count(*) AS n FROM record_field_index s
         WHERE s."tableId" = ? AND s."recordId" NOT IN
           (SELECT id FROM records WHERE "tableId" = ? AND "deletedAt" IS NULL)`,
      )
      .get(meta.tableId, meta.tableId) as { n: number }
  ).n;
  if (orphans > 0) pushSample(`orphan rows: ${orphans}`);

  return { tableId: meta.tableId, expected, actualForLive, missing, extra, mismatch, orphans, samples };
}

const metas = loadTableMetas(db, onlyTable || undefined);
if (metas.length === 0) {
  console.error(`未找到表${onlyTable ? `：${onlyTable}` : "（库中无活表）"}`);
  process.exit(1);
}

const reports = metas.map(checkTable);
let drift = 0;
for (const r of reports) {
  const tableDrift = r.missing + r.extra + r.mismatch + r.orphans;
  drift += tableDrift;
  console.log(
    `table=${r.tableId} expected=${r.expected} actualForLive=${r.actualForLive} ` +
      `missing=${r.missing} extra=${r.extra} mismatch=${r.mismatch} orphans=${r.orphans} ` +
      `drift=${tableDrift}`,
  );
  for (const s of r.samples) console.log(`  - ${s}`);
}
console.log(JSON.stringify({ tables: reports.length, drift }));
db.close();
if (drift !== 0) {
  console.error(`SIDECAR DRIFT DETECTED: ${drift}`);
  process.exit(1);
}
console.log("SIDECAR DRIFT = 0");
