#!/usr/bin/env node
// scripts/backfill-auto-number-counters.mjs
// autoNumber 高水位计数器存量回填（配合迁移 20260925010000_auto_number_counters）。
//
// 为什么需要它：迁移只建了空的 auto_number_counters 表；不回填的话，升级后新建记录
// 会从 0001 重新发号，与存量编号撞车。本脚本按【当前活记录】把每个 counter 段各桶的
// 高水位（=该桶活记录数）seed 进去，使升级后新建记录拿到下一号。
//
// 用法（必须在 prisma migrate deploy 成功、auto_number_counters 表已建之后执行）：
//   DATABASE_URL="file:/var/lib/gouxiangdb/app.db" node scripts/backfill-auto-number-counters.mjs
//   # 预览/开发： DATABASE_URL="file:./prisma/dev.db"  node scripts/backfill-auto-number-counters.mjs
//   # --dry-run 只打印将要写入的计数器，不落库
//
// 幂等：已存在的 (tableId,key) 一律跳过（INSERT ... WHERE NOT EXISTS），可重复执行，
// 不会把运行中已增长的计数器覆盖回旧值。老记录已生成的编号字符串不做任何改动。

import Database from "better-sqlite3";
import process from "node:process";

function toComparable(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => String(x)).join(",");
  return String(v);
}

function timeBucket(date, reset) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  if (reset === "year") return String(y);
  if (reset === "month") return `${y}${m}`;
  return `${y}${m}${d}`;
}

function parseFields(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function dbFileFromUrl(url) {
  if (!url || !url.startsWith("file:")) {
    throw new Error("DATABASE_URL 必须是 SQLite file: 连接串，形如 file:/var/lib/gouxiangdb/app.db");
  }
  return url.slice("file:".length).split("?")[0];
}

const dryRun = process.argv.includes("--dry-run");
const dbFile = dbFileFromUrl(process.env.DATABASE_URL);
const db = new Database(dbFile);

// 所有带非空 numberRule 的 autoNumber 字段。
const fields = db.prepare(
  `SELECT "id", "tableId", "numberRule" FROM "fields"
   WHERE "type"='autoNumber' AND "deletedAt" IS NULL AND "numberRule" IS NOT NULL`,
).all();

const selectRows = db.prepare(
  `SELECT "fields", "createdAt" FROM "records"
   WHERE "tableId"=? AND "deletedAt" IS NULL ORDER BY "createdAt" ASC, "id" ASC`,
);

const exists = db.prepare(
  `SELECT 1 FROM "auto_number_counters" WHERE "tableId"=? AND "key"=?`,
);
const insert = db.prepare(
  `INSERT INTO "auto_number_counters" ("id","tableId","key","value")
   SELECT ?, ?, ?, ? WHERE NOT EXISTS (
     SELECT 1 FROM "auto_number_counters" WHERE "tableId"=? AND "key"=?
   )`,
);

let seeded = 0;
let skippedExisting = 0;
let counterSegs = 0;

for (const f of fields) {
  let rule;
  try {
    rule = JSON.parse(f.numberRule);
  } catch {
    continue;
  }
  const segs = Array.isArray(rule?.segments) ? rule.segments : [];
  const counterIndexes = segs
    .map((s, i) => ({ seg: s, i }))
    .filter((x) => x.seg?.type === "counter");
  counterSegs += counterIndexes.length;
  if (counterIndexes.length === 0) continue;

  const rows = selectRows.all(f.tableId);
  // key -> 活记录计数（高水位）
  const hwm = new Map();
  for (const r of rows) {
    const createdAt = new Date(r.createdAt);
    const stored = parseFields(r.fields);
    for (const { seg, i } of counterIndexes) {
      let resetKind;
      let bucket;
      if (seg.reset === "year" || seg.reset === "month" || seg.reset === "day") {
        resetKind = seg.reset;
        bucket = timeBucket(createdAt, seg.reset);
      } else if (seg.reset === "field") {
        resetKind = "field";
        bucket = seg.resetFieldId ? toComparable(stored[seg.resetFieldId]) : "";
      } else {
        resetKind = "global";
        bucket = "global";
      }
      const key = `${f.id}:${i}:${resetKind}:${bucket}`;
      hwm.set(key, (hwm.get(key) ?? 0) + 1);
    }
  }

  for (const [key, value] of hwm) {
    if (exists.get(f.tableId, key)) {
      skippedExisting += 1;
      continue;
    }
    const id = `anc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    if (dryRun) {
      console.log(`[dry-run] tableId=${f.tableId} key=${key} value=${value}`);
    } else {
      insert.run(id, f.tableId, key, value, f.tableId, key);
    }
    seeded += 1;
  }
}

db.close();
console.log(
  `autoNumber 回填完成：${fields.length} 个 autoNumber 字段、${counterSegs} 个 counter 段；`
    + `${dryRun ? "预计 " : ""}seed ${seeded} 个计数器，跳过已存在 ${skippedExisting} 个。`,
);
