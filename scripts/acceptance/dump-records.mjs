#!/usr/bin/env node
// scripts/acceptance/dump-records.mjs
// 升级前/后只读全量取证（零 ORM，better-sqlite3 只读连接）。产出 snapshot.json：
//   - 表清单、迁移台账
//   - 15 张 v0.1.0 旧表的逐表 count、id 集、全量行（含时间戳原文，供"旧行时间戳零改动"检查）
//   - uploads 树清单（相对路径 + size + sha256）
// before/after 用同一脚本导出同构 JSON，交由 diff-snapshot.mjs 归一化比对。
//
// 退出码：0 成功；64 参数/环境错；1 取证失败。

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { openDb, appTables, migrationLedger, countOf, allRows, columnsOf } from "./lib/db.mjs";

// v0.1.0 15 张旧表（零损坏比对的业务面）。新表（nav_nodes/auth_policies/...）不参与 before/after 业务 diff。
const LEGACY_TABLES = [
  "bases", "comments", "fields", "kb_doc_acls", "kb_doc_versions", "kb_docs",
  "kb_members", "knowledge_bases", "link_rows", "members", "records",
  "share_links", "tables", "users", "views",
];

// 旧行时间戳列（补强 3：迁移必须 0 改动这些列，单独按原文逐行比对，不走归一化）。
const TIMESTAMP_COLUMNS = ["createdAt", "updatedAt", "deletedAt", "joinedAt"];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function fail(code, msg) {
  console.error(`[dump-records] ${msg}`);
  process.exit(code);
}

const dbFile = arg("--db");
const outDir = arg("--out");
const uploadRoot = arg("--uploads");
if (!dbFile || !outDir) fail(64, "用法: dump-records.mjs --db <abs.db> --out <dir> [--uploads <dir>]");

function stable(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return { __date__: value.toISOString() };
  if (Buffer.isBuffer(value)) return { __buf_hex__: value.toString("hex") };
  if (typeof value === "bigint") return { __bigint__: value.toString() };
  return value;
}

/** 把一行规整为 JSON 安全对象（Date 保留 ISO 原文，不丢精度）。 */
function normalizeRow(row, columns) {
  const out = {};
  for (const col of columns) out[col] = stable(row[col]);
  return out;
}

function walkUploads(root) {
  const files = [];
  const walk = (dir, relPrefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, rel);
      else if (e.isFile()) {
        const buf = fs.readFileSync(abs);
        files.push({
          relPath: rel,
          size: buf.length,
          sha256: crypto.createHash("sha256").update(buf).digest("hex"),
        });
      }
    }
  };
  walk(root, "");
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

function main() {
  const db = openDb(dbFile, { readonly: true });
  const tablesAll = appTables(db);
  const ledger = migrationLedger(db);

  const snapshot = {
    dumpedAt: new Date().toISOString(),
    dbFile: path.resolve(dbFile),
    tableCount: tablesAll.length,
    tables: tablesAll,
    migrations: { total: ledger.total, finished: ledger.finished, rolledBack: ledger.rolledBack },
    legacy: {},
    uploads: uploadRoot ? walkUploads(uploadRoot) : null,
  };

  for (const t of LEGACY_TABLES) {
    if (!tablesAll.includes(t)) {
      snapshot.legacy[t] = { present: false };
      continue;
    }
    const cols = columnsOf(db, t);
    const rows = allRows(db, t, null);
    snapshot.legacy[t] = {
      present: true,
      count: countOf(db, t),
      columns: cols,
      timestampColumns: cols.filter((c) => TIMESTAMP_COLUMNS.includes(c)),
      idSet: rows.map((r) => String(r.id ?? r.rowid)).sort(),
      rows: rows.map((r) => normalizeRow(r, cols)),
    };
  }

  db.close();
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "snapshot.json");
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  const counts = LEGACY_TABLES.filter((t) => snapshot.legacy[t]?.present).map((t) => `${t}=${snapshot.legacy[t].count}`);
  console.log(`[dump] 表 ${snapshot.tableCount}，迁移 ${snapshot.migrations.finished}/${snapshot.migrations.total}（回滚 ${snapshot.migrations.rolledBack}）`);
  console.log(`[dump] ${counts.join(" ")}`);
  if (snapshot.uploads) console.log(`[dump] uploads ${snapshot.uploads.length} 个文件`);
  console.log(`[dump] -> ${file}`);
}

try {
  main();
} catch (e) {
  fail(1, `取证失败：${e.stack || e.message || e}`);
}
