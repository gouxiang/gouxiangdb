// apps/api/src/db/rawRead.ts
// 只读 raw 连接网关 + COUNT/keyset 查询原语（M1/S2）。
// 定位：本片刻画「可测原语」，不挂任何路由、不改 HTTP 输出、不读 sidecar。
// 独立 better-sqlite3【只读】连接：WAL 下只读不阻塞写者，也不与 Prisma 写连接
// 构成跨连接事务；只读打开本身阻止一切误写。排序固定 (createdAt ASC, id ASC)，
// 与 recordService.recordFindMany 现状一致；游标谓词用可移植展开式（旧 SQLite/PG
// 均不依赖行值比较）：("createdAt" > ? OR ("createdAt" = ? AND "id" > ?))。
// 类型口径：Prisma 把 DateTime 以 epoch 毫秒【整数】存入 SQLite，故游标 createdAt
// 统一用 number(ms) 绑定，id 为 TEXT。

import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { resolveDatabaseFile } from "./databaseFile.js";

/** keyset 游标：createdAt 为 epoch 毫秒；null 表示从头一页取起。 */
export interface KeysetCursor {
  createdAt: number;
  id: string;
}

export type KeysetOrder = "asc" | "desc";

/** better-sqlite3 接受的绑定值（不含 boolean/undefined，布尔需调用方转 0/1）。 */
export type SqlBindValue = string | number | bigint | Buffer | null;

export interface KeysetPageArgs {
  tableId: string;
  cursor: KeysetCursor | null;
  limit: number;
  /** 附加 WHERE 片段（不含 WHERE 关键字），必须为固定 SQL，值走 params 绑定防注入。 */
  whereSql?: string;
  /** 与 whereSql 占位符顺序对应的绑定参数（不含 tableId 与游标三参）。 */
  params?: SqlBindValue[];
  order?: KeysetOrder;
}

/** 列表所需的最小列投影（raw 直读，不经 Prisma）。 */
export interface RawRecordRow {
  id: string;
  tableId: string;
  fields: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
}

export interface KeysetPage {
  rows: RawRecordRow[];
  /** 本页满 limit 时有下一页，返回末行游标；否则 null。 */
  nextCursor: KeysetCursor | null;
}

export interface RawReader {
  /** 表内活行数（deletedAt IS NULL）。 */
  countLive(tableId: string): number;
  /** 按附加谓词计数：whereSql 固定片段、params 顺序绑定；S6 queryPlan 用。 */
  countByPlan(tableId: string, whereSql?: string, params?: SqlBindValue[]): number;
  /** keyset 翻一页；跨页不重不漏，排序在 (createdAt,id) 上稳定。 */
  keysetPage(args: KeysetPageArgs): KeysetPage;
  /** 关闭底层只读连接（测试/优雅停机）。 */
  close(): void;
}

const COLUMNS = '"id", "tableId", "fields", "createdAt", "updatedAt", "createdBy", "updatedBy"';
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 20;

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

/**
 * 用一个已打开的 better-sqlite3 连接构造原语（连接由调用方拥有，便于测试传临时库；
 * 只读保证来自 openRawReader 的 readonly:true，任何写语句在只读连接上直接抛错）。
 */
export function createRawReader(db: Database.Database): RawReader {
  const liveWhere = (extra = "") => `"tableId" = ? AND "deletedAt" IS NULL${extra ? ` ${extra}` : ""}`;

  function countLive(tableId: string): number {
    const row = db.prepare(`SELECT count(*) AS n FROM records WHERE ${liveWhere()}`).get(tableId) as { n: number };
    return Number(row.n);
  }

  function countByPlan(tableId: string, whereSql = "", params: SqlBindValue[] = []): number {
    const row = db
      .prepare(`SELECT count(*) AS n FROM records WHERE ${liveWhere(whereSql)}`)
      .get(tableId, ...params) as { n: number };
    return Number(row.n);
  }

  function keysetPage(args: KeysetPageArgs): KeysetPage {
    const { tableId, cursor, whereSql = "", params = [], order = "asc" } = args;
    const limit = normalizeLimit(args.limit);
    const dir = order === "desc" ? "DESC" : "ASC";
    const cmp = order === "desc" ? "<" : ">"; // asc 用 >，desc 用 <（同毫秒 id 同向）
    const cursorClause = cursor
      ? `AND ("createdAt" ${cmp} ? OR ("createdAt" = ? AND "id" ${cmp} ?))`
      : "";
    // 绑定顺序须与 SQL 占位符同序：tableId → whereSql 参数 → 游标三参 → LIMIT。
    const bind: SqlBindValue[] = [tableId, ...params];
    if (cursor) bind.push(cursor.createdAt, cursor.createdAt, cursor.id);
    bind.push(limit + 1); // 多取 1 行判断是否有下一页，不返回给调用方

    const sql =
      `SELECT ${COLUMNS} FROM records WHERE ${liveWhere(whereSql)} ${cursorClause} ` +
      `ORDER BY "createdAt" ${dir}, "id" ${dir} LIMIT ?`;
    const fetched = db.prepare(sql).all(...bind) as RawRecordRow[];
    const hasNext = fetched.length > limit;
    const rows = hasNext ? fetched.slice(0, limit) : fetched;
    const last = rows[rows.length - 1];
    return { rows, nextCursor: hasNext && last ? { createdAt: last.createdAt, id: last.id } : null };
  }

  return { countLive, countByPlan, keysetPage, close: () => db.close() };
}

/** 以只读方式打开文件并构造 reader；busy_timeout 与 db.ts 写连接同口径 5000ms。 */
export function openRawReader(file: string): RawReader {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 5000 });
  db.pragma("busy_timeout = 5000");
  return createRawReader(db);
}

// ---- 进程级默认单例（惰性；测试用 createRawReader/openRawReader 传临时库，不碰它）----

let defaultReader: RawReader | undefined;

/** 解析 config 指向的库文件绝对路径（相对 DATABASE_URL 相对 prisma/ 目录）。 */
export function defaultDatabaseFile(): string {
  return resolveDatabaseFile(config.databaseUrl, path.dirname(config.migrationsDir));
}

/** 获取进程级只读 reader 单例；首调时打开文件（需库已由迁移创建）。 */
export function getRawReader(): RawReader {
  if (!defaultReader) defaultReader = openRawReader(defaultDatabaseFile());
  return defaultReader;
}

/** 测试/优雅停机用：关闭并清空单例。 */
export function closeRawReader(): void {
  defaultReader?.close();
  defaultReader = undefined;
}
