// apps/api/scripts/bench/sidecar-lib.ts
// backfill / check sidecar 脚本共享的只读 IO（better-sqlite3 直连，不经 Prisma，
// 便于离线、分批、可重跑）。期望值算法不在此复制——统一用 policy.buildExpectedRows。

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { resolveDatabaseFile } from "../../src/db/databaseFile.js";
import { buildExpectedRows, type ExpectedSidecarRow } from "../../src/domain/fieldIndex/policy.js";

export interface TableMeta {
  tableId: string;
  primaryFieldId: string;
  fieldsMeta: Array<{ id: string; type: string }>;
}

/** 从 DATABASE_URL 解析库文件（相对路径相对 prisma/ 目录，与应用同口径）。 */
export function resolveDbFile(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("缺少 DATABASE_URL，形如 file:/var/lib/gouxiangdb/app.db");
  const prismaDir = path.join(process.cwd(), "prisma");
  return resolveDatabaseFile(url, prismaDir);
}

export function openDb(readonly: boolean): Database.Database {
  const file = resolveDbFile();
  if (!fs.existsSync(file)) throw new Error(`数据库文件不存在：${file}`);
  const db = new Database(file, { readonly, timeout: 30000 });
  db.pragma("busy_timeout = 30000");
  return db;
}

/** 读取目标表集合（--table 指定单个，否则全部非软删表）及其活字段元数据。 */
export function loadTableMetas(db: Database.Database, onlyTableId?: string): TableMeta[] {
  const tables = db
    .prepare(
      `SELECT id, "primaryFieldId" AS primaryFieldId FROM tables
       WHERE "deletedAt" IS NULL${onlyTableId ? " AND id = ?" : ""}`,
    )
    .all(...(onlyTableId ? [onlyTableId] : [])) as Array<{ id: string; primaryFieldId: string }>;

  return tables.map((t) => ({
    tableId: t.id,
    primaryFieldId: t.primaryFieldId ?? "",
    fieldsMeta: db
      .prepare(
        `SELECT id, type FROM fields WHERE "tableId" = ? AND "deletedAt" IS NULL ORDER BY "order"`,
      )
      .all(t.id) as Array<{ id: string; type: string }>,
  }));
}

interface RawRecord {
  id: string;
  tableId: string;
  fields: string;
}

/** id > lastId 游标分批拉取某表活记录（稳定、不依赖 OFFSET）。 */
export function nextRecordBatch(
  db: Database.Database,
  tableId: string,
  lastId: string,
  batch: number,
): RawRecord[] {
  return db
    .prepare(
      `SELECT id, "tableId", fields FROM records
       WHERE "tableId" = ? AND "deletedAt" IS NULL AND id > ?
       ORDER BY id LIMIT ?`,
    )
    .all(tableId, lastId, batch) as RawRecord[];
}

/** 由字段元数据 + 一批记录算出期望 sidecar 行（单一事实源）。 */
export function expectedFor(meta: TableMeta, records: RawRecord[]): ExpectedSidecarRow[] {
  return buildExpectedRows({
    fieldsMeta: meta.fieldsMeta,
    primaryFieldId: meta.primaryFieldId,
    records: records.map((r) => ({ id: r.id, tableId: r.tableId, fields: r.fields })),
  });
}

/** sidecar 实际行的比较键。 */
export function rowKey(r: { recordId: string; fieldId: string; ord: number }): string {
  return `${r.recordId}|${r.fieldId}|${r.ord}`;
}

export interface ActualRow {
  recordId: string;
  fieldId: string;
  ord: number;
  valueText: string | null;
  valueNum: number | null;
  isNull: number;
}

export function fetchActualRows(db: Database.Database, recordIds: string[]): ActualRow[] {
  if (recordIds.length === 0) return [];
  const ph = recordIds.map(() => "?").join(",");
  return db
    .prepare(
      // 注意：不给 "isNull" 起 AS 别名——SQLite 解析器把 `AS isNull` 当语法错；
      // 裸引用列名，better-sqlite3 返回键即原名 "isNull"。
      `SELECT "recordId", "fieldId", ord, "valueText", "valueNum", "isNull"
       FROM record_field_index WHERE "recordId" IN (${ph})`,
    )
    .all(...recordIds) as ActualRow[];
}

/** 值是否一致（valueNum 用数值容差，SQLite REAL 往返）。 */
export function valueEqual(a: ActualRow, e: ExpectedSidecarRow): boolean {
  if (a.isNull !== e.isNull) return false;
  if ((a.valueText ?? null) !== (e.valueText ?? null)) return false;
  if (a.valueNum === null || e.valueNum === null) return a.valueNum === e.valueNum;
  return Math.abs(a.valueNum - e.valueNum) < 1e-9;
}
