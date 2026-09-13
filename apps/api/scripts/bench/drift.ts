// apps/api/scripts/bench/drift.ts
// M1/S9 run-gate：写轮结束后离线对拍 sidecar drift（不经过服务进程，避免 WAL 竞争）。
// 期望值统一走 policy.buildExpectedRows，与 backfill/check/生成器同一事实源；
// 但判定逻辑在此独立实现（missing/extra/mismatch/orphans 全计），不是只对拍自己。

import type Database from "better-sqlite3";
import { buildExpectedRows } from "../../src/domain/fieldIndex/policy.js";

const BATCH = 1000;

interface RawRec { id: string; tableId: string; fields: string }
interface ActualRow {
  recordId: string; fieldId: string; ord: number;
  valueText: string | null; valueNum: number | null; isNull: number;
}

function rowKey(r: { recordId: string; fieldId: string; ord: number }): string {
  return `${r.recordId}|${r.fieldId}|${r.ord}`;
}

function valEqual(a: ActualRow, e: ActualRow): boolean {
  if (a.isNull !== e.isNull) return false;
  if ((a.valueText ?? null) !== (e.valueText ?? null)) return false;
  if (a.valueNum === null || e.valueNum === null) return a.valueNum === e.valueNum;
  return Math.abs(a.valueNum - e.valueNum) < 1e-9;
}

export interface DriftReport {
  drift: number;
  missing: number;
  extra: number;
  mismatch: number;
  orphans: number;
}

/** 全库对拍活记录的 sidecar 行；返回四类差异计数。 */
export function countSidecarDrift(db: Database.Database): DriftReport {
  const tables = db.prepare(
    `SELECT id, "primaryFieldId" AS pf FROM tables WHERE "deletedAt" IS NULL`,
  ).all() as Array<{ id: string; pf: string }>;
  const total: DriftReport = { drift: 0, missing: 0, extra: 0, mismatch: 0, orphans: 0 };

  for (const { id: tableId, pf } of tables) {
    const fieldsMeta = db.prepare(
      `SELECT id, type FROM fields WHERE "tableId"=? AND "deletedAt" IS NULL ORDER BY "order"`,
    ).all(tableId) as Array<{ id: string; type: string }>;

    let lastId = "";
    for (;;) {
      const recs = db.prepare(
        `SELECT id,"tableId",fields FROM records
         WHERE "tableId"=? AND "deletedAt" IS NULL AND id > ? ORDER BY id LIMIT ?`,
      ).all(tableId, lastId, BATCH) as RawRec[];
      if (recs.length === 0) break;
      const expected = buildExpectedRows({
        primaryFieldId: pf,
        fieldsMeta,
        records: recs.map((r) => ({ id: r.id, tableId: r.tableId, fields: r.fields })),
      });
      const ids = recs.map((r) => r.id);
      const ph = ids.map(() => "?").join(",");
      const actual = db.prepare(
        `SELECT "recordId","fieldId",ord,"valueText","valueNum","isNull"
         FROM record_field_index WHERE "recordId" IN (${ph})`,
      ).all(...ids) as ActualRow[];
      const expByKey = new Map(expected.map((e) => [rowKey(e), e]));
      const actByKey = new Map(actual.map((a) => [rowKey(a), a]));
      for (const [k, e] of expByKey) {
        const a = actByKey.get(k);
        if (!a) total.missing++;
        else if (!valEqual(a, e as ActualRow)) total.mismatch++;
      }
      for (const k of actByKey.keys()) if (!expByKey.has(k)) total.extra++;
      lastId = recs[recs.length - 1]!.id;
      if (recs.length < BATCH) break;
    }

    total.orphans += (db.prepare(
      `SELECT count(*) AS n FROM record_field_index s
       WHERE s."tableId"=? AND s."recordId" NOT IN
         (SELECT id FROM records WHERE "tableId"=? AND "deletedAt" IS NULL)`,
    ).get(tableId, tableId) as { n: number }).n;
  }

  total.drift = total.missing + total.extra + total.mismatch + total.orphans;
  return total;
}
