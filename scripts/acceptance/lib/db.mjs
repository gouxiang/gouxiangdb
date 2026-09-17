// scripts/acceptance/lib/db.mjs
// 只读/裸 SQL 访问辅助（零 ORM，版本无关）。better-sqlite3 从 apps/api 的 node_modules 解析
// （monorepo pnpm 把原生依赖装在那里），避免给根仓新增依赖。
//
// 单一职责：打开 DB、枚举表、count、id 集、通用只读查询。不含任何业务判定/归一化。

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/acceptance/lib -> 仓库根 -> apps/api
export const REPO_ROOT = path.resolve(__dirname, "../../..");
export const API_DIR = path.join(REPO_ROOT, "apps/api");

const require = createRequire(import.meta.url);

/**
 * 解析 better-sqlite3：优先 apps/api 的安装（pnpm workspace），失败再尝试常规解析。
 * @returns {typeof import("better-sqlite3")}
 */
export function loadBetterSqlite3() {
  const candidates = [
    path.join(API_DIR, "node_modules", "better-sqlite3"),
    path.join(REPO_ROOT, "node_modules", "better-sqlite3"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "package.json"))) return require(c);
    } catch { /* 尝试下一个 */ }
  }
  return require("better-sqlite3");
}

/**
 * 打开数据库（默认只读）。
 * @param {string} file 绝对路径
 * @param {{readonly?: boolean}} [opts]
 */
export function openDb(file, opts = {}) {
  const Database = loadBetterSqlite3();
  if (!fs.existsSync(file)) {
    const e = new Error(`数据库文件不存在：${file}`);
    e.code = "DB_NOT_FOUND";
    throw e;
  }
  return new Database(file, { readonly: opts.readonly !== false, fileMustExist: true });
}

/** 应用表名（剔除 sqlite 内部与 prisma 迁移台账），按名排序。 */
export function appTables(db) {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' "
        + "AND name NOT LIKE 'sqlite_%' AND name <> '_prisma_migrations' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

/** 迁移台账：{total, finished, rolledBack, names}。 */
export function migrationLedger(db) {
  const row = db
    .prepare(
      "SELECT count(*) AS total, sum(CASE WHEN finished_at IS NOT NULL THEN 1 ELSE 0 END) AS finished, " +
        "sum(CASE WHEN rolled_back_at IS NOT NULL THEN 1 ELSE 0 END) AS rolledBack FROM _prisma_migrations",
    )
    .get();
  const names = db
    .prepare("SELECT migration_name AS name, rolled_back_at AS rb FROM _prisma_migrations ORDER BY started_at")
    .all();
  return { total: row.total, finished: row.finished, rolledBack: row.rolledBack, names };
}

/** 全表 count（含软删行，count(*) 口径）。表不存在抛错（由调用方决定）。 */
export function countOf(db, table) {
  return db.prepare(`SELECT count(*) AS c FROM "${table}"`).get().c;
}

/** 全量 id 集（字符串数组，排序）。表无 id 列时回退 rowid。 */
export function idSet(db, table) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  const key = cols.includes("id") ? "id" : "rowid";
  return db
    .prepare(`SELECT ${key} AS k FROM "${table}"`)
    .all()
    .map((r) => String(r.k))
    .sort();
}

/** 取某表全部行（JSON 安全），按可选列排序。 */
export function allRows(db, table, orderBy) {
  const order = orderBy ? ` ORDER BY ${orderBy}` : "";
  return db.prepare(`SELECT * FROM "${table}"${order}`).all();
}

/** 某表列名集合。 */
export function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
}
