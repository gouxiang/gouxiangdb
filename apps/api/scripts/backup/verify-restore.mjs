#!/usr/bin/env node
// apps/api/scripts/backup/verify-restore.mjs
// 对（已解密的）恢复候选目录跑完整性校验：integrity_check + 迁移数 + 关键表计数 + sha256
// 与同目录 manifest 对账。**只读校验，绝不覆盖现网任何文件**。
// 用法：node verify-restore.mjs <candidate-dir>
//   候选目录内应有 app-*.db 与 app-*.manifest.json（age 解密/解 tar 后）。
// 退出码：0 PASS；1 FAIL；64 参数/文件错误。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const KEY_TABLES = [
  "bases", "tables", "fields", "views", "records",
  "members", "users", "knowledge_bases", "kb_docs", "comments",
];

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function removeSidecars(file) {
  for (const ext of ["-wal", "-shm"]) {
    try { fs.rmSync(`${file}${ext}`, { force: true }); } catch { /* ignore */ }
  }
}

function inspect(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get();
    const integrity = String(row.integrity_check ?? Object.values(row)[0]);
    const mig = db
      .prepare("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name")
      .all();
    const counts = {};
    for (const t of KEY_TABLES) {
      try { counts[t] = db.prepare(`SELECT count(*) c FROM "${t}"`).get().c; }
      catch { counts[t] = 0; }
    }
    return { integrity, appliedMigrations: mig.length, latestMigration: mig.at(-1)?.migration_name ?? null, counts };
  } finally {
    db.close();
    removeSidecars(file);
  }
}

function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("用法: verify-restore.mjs <candidate-dir>");
    process.exit(64);
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`候选目录不存在或非目录：${dir}`);
    process.exit(64);
  }
  const dbFile = fs.readdirSync(dir).find((f) => /^app-.*\.db$/.test(f));
  const manifestFile = fs.readdirSync(dir).find((f) => f.endsWith(".manifest.json"));
  if (!dbFile) {
    console.error("候选目录缺少 app-*.db");
    process.exit(64);
  }
  const dbPath = path.join(dir, dbFile);
  const info = inspect(dbPath);

  const problems = [];
  if (info.integrity !== "ok") problems.push(`integrity_check=${info.integrity}`);

  let manifest = null;
  if (manifestFile) {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, manifestFile), "utf8"));
    const hash = sha256File(dbPath);
    if (hash !== manifest.database.sha256) problems.push("sha256 mismatch");
    if (info.appliedMigrations !== manifest.database.appliedMigrations) {
      problems.push(`migrations ${info.appliedMigrations} != manifest ${manifest.database.appliedMigrations}`);
    }
    for (const [table, expected] of Object.entries(manifest.database.counts || {})) {
      if ((info.counts[table] ?? 0) !== expected) {
        problems.push(`count ${table} ${info.counts[table] ?? 0} != manifest ${expected}`);
      }
    }
  } else {
    problems.push("缺少 manifest（仅能给出 integrity/计数，无法做哈希与源库对账）");
  }

  console.log("snapshot:", dbFile);
  console.log("integrity_check:", info.integrity);
  console.log("applied migrations:", info.appliedMigrations, "latest:", info.latestMigration);
  console.log("counts:", JSON.stringify(info.counts));
  if (manifest) {
    console.log("source appVersion:", manifest.appVersion, "createdAt:", manifest.createdAt);
  }

  if (problems.length) {
    console.error("VERIFY FAIL:");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log("VERIFY PASS");
}

main();
