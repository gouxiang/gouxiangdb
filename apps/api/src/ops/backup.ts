// apps/api/src/ops/backup.ts
// SQLite 在线备份核心：better-sqlite3 .backup() 一致性快照（live WAL 下安全，自动合并 WAL）、
// 快照校验（integrity_check / 迁移数 / 关键表计数）、manifest 组装、daily+weekly 保留裁剪。
// 纯函数（保留裁剪/manifest 比对/时间戳解析）不碰文件系统，便于单测；
// I/O 函数只对给定路径操作，绝不写源库。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { VERSION } from "../version.js";

// 计数对账的关键业务表（快照与源库必须一致；表名来自 prisma schema，均为静态白名单）。
export const KEY_TABLES = [
  "bases",
  "tables",
  "fields",
  "views",
  "records",
  "members",
  "users",
  "knowledge_bases",
  "kb_docs",
  "comments",
  // R2 附件外置：附件行纳入计数对账（注意只验【行】，物理文件的一致性由
  // scripts/backup/online-backup.mjs 的 uploads tar + 漏备告警负责）。
  "attachments",
] as const;

type TableCounts = Record<string, number>;

interface SnapshotInfo {
  integrity: string;
  appliedMigrations: number;
  latestMigration: string | null;
  counts: TableCounts;
}

// 在线一致性备份到一个全新文件（WAL 自动合并，不 cp -wal/-shm）。
export async function backupDatabase(
  sourceFile: string,
  destFile: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const src = new Database(sourceFile);
  try {
    await src.backup(destFile);
  } finally {
    src.close();
  }
}

// 清理只读打开快照时 SQLite 可能在同目录生成的空 -wal/-shm 副产物。
// 仅用于快照文件；.backup() 已把 WAL 合并进主文件，删除空 sidecar 不影响数据（已实测）。
// 绝不可对正在服务的源库调用。
function removeSnapshotSidecars(file: string): void {
  for (const ext of ["-wal", "-shm"]) {
    try {
      fs.rmSync(`${file}${ext}`, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// 只读打开快照做校验（不修改快照数据；仅清理只读连接产生的空 sidecar）。
export function inspectSnapshot(file: string): SnapshotInfo {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown>;
    const integrity = String(
      row.integrity_check ?? Object.values(row)[0] ?? "unknown",
    );
    const mig = db
      .prepare(
        "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name",
      )
      .all() as Array<{ migration_name: string }>;
    const counts: TableCounts = {};
    for (const t of KEY_TABLES) {
      try {
        counts[t] = (db.prepare(`SELECT count(*) AS c FROM "${t}"`).get() as { c: number }).c;
      } catch {
        counts[t] = 0;
      }
    }
    return {
      integrity,
      appliedMigrations: mig.length,
      latestMigration: mig[mig.length - 1]?.migration_name ?? null,
      counts,
    };
  } finally {
    db.close();
    removeSnapshotSidecars(file);
  }
}

export function sha256File(file: string): string {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

// ============ 纯函数：时间戳 / 保留策略 / manifest 比对 ============

interface BackupEntry {
  file: string;
  date: Date;
}

// 文件名形如 app-YYYYmmdd[-HHMMSS].db，取日期段。
export function parseStamp(file: string): Date | null {
  const m = file.match(/(\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  const dt = new Date(Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? 0),
    Number(mi ?? 0),
    Number(ss ?? 0),
  ));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// ISO 周号（同周即视为同一周桶）。
function isoWeekKey(dt: Date): string {
  const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

interface RetentionPolicy {
  daily: number; // 保留最近 N 个有备份的日历日
  weekly: number; // 另保留最近 N 个 ISO 周的周末份
}

const DEFAULT_RETENTION: RetentionPolicy = { daily: 7, weekly: 4 };

/**
 * 纯保留裁剪：返回应保留的文件名集合（daily ∪ weekly），其余可删。
 * - daily：每个日历日只留当天最新一份，取最近 policy.daily 个不同日。
 * - weekly：每个 ISO 周优先取周日（getUTCDay=0）的最新一份，无周日则该周最新一份；
 *   取最近 policy.weekly 个不同周。
 */
export function selectRetention(
  entries: BackupEntry[],
  policy: RetentionPolicy = DEFAULT_RETENTION,
  now: Date = new Date(),
): Set<string> {
  const valid = entries
    .filter((e) => e.date.getTime() <= now.getTime() + 1000)
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  // 每日最新（已按时间倒序，某日第一次出现即当天最新）
  const latestPerDay = new Map<string, BackupEntry>();
  for (const e of valid) {
    const k = e.date.toISOString().slice(0, 10);
    if (!latestPerDay.has(k)) latestPerDay.set(k, e);
  }
  const dailyKeep = [...latestPerDay.values()].slice(0, policy.daily);

  // 每周代表：优先周日，否则该周最新
  const perWeek = new Map<string, BackupEntry[]>();
  for (const e of valid) {
    const k = isoWeekKey(e.date);
    if (!perWeek.has(k)) perWeek.set(k, []);
    perWeek.get(k)!.push(e);
  }
  const weekRepresentatives: Array<{ key: string; entry: BackupEntry }> = [];
  for (const [key, list] of perWeek) {
    const sunday = list
      .filter((e) => e.date.getUTCDay() === 0)
      .sort((a, b) => b.date.getTime() - a.date.getTime())[0];
    weekRepresentatives.push({ key, entry: sunday ?? list[0]! });
  }
  weekRepresentatives.sort((a, b) => b.entry.date.getTime() - a.entry.date.getTime());
  const weeklyKeep = weekRepresentatives.slice(0, policy.weekly).map((x) => x.entry);

  return new Set([...dailyKeep, ...weeklyKeep].map((e) => e.file));
}

interface ManifestFileInfo {
  sha256: string;
  bytes: number;
}

interface BackupManifest {
  format: "gouxiangdb-backup-manifest";
  manifestVersion: 1;
  appVersion: string;
  createdAt: string;
  database: {
    file: string;
    integrity: string;
    appliedMigrations: number;
    latestMigration: string | null;
    counts: TableCounts;
    sha256: string;
    bytes: number;
  };
  uploads: ManifestFileInfo & { file: string } | null;
}

// 纯组装（不读文件，哈希/计数由调用方传入）。
export function buildManifest(input: {
  createdAt: Date;
  dbFileName: string;
  info: SnapshotInfo;
  dbHash: string;
  dbBytes: number;
  uploads?: { file: string; sha256: string; bytes: number } | null;
}): BackupManifest {
  return {
    format: "gouxiangdb-backup-manifest",
    manifestVersion: 1,
    appVersion: VERSION,
    createdAt: input.createdAt.toISOString(),
    database: {
      file: input.dbFileName,
      integrity: input.info.integrity,
      appliedMigrations: input.info.appliedMigrations,
      latestMigration: input.info.latestMigration,
      counts: input.info.counts,
      sha256: input.dbHash,
      bytes: input.dbBytes,
    },
    uploads: input.uploads
      ? { file: input.uploads.file, sha256: input.uploads.sha256, bytes: input.uploads.bytes }
      : null,
  };
}

interface VerifyResult {
  pass: boolean;
  problems: string[];
}

// 纯比对：恢复快照实测值与 manifest 对账。
export function verifyAgainstManifest(
  info: SnapshotInfo,
  manifest: BackupManifest,
  hashOk: boolean,
): VerifyResult {
  const problems: string[] = [];
  if (info.integrity !== "ok") problems.push(`integrity_check=${info.integrity}`);
  if (info.appliedMigrations !== manifest.database.appliedMigrations) {
    problems.push(
      `migrations ${info.appliedMigrations} != manifest ${manifest.database.appliedMigrations}`,
    );
  }
  for (const [table, expected] of Object.entries(manifest.database.counts)) {
    if ((info.counts[table] ?? 0) !== expected) {
      problems.push(`count ${table} ${info.counts[table] ?? 0} != ${expected}`);
    }
  }
  if (!hashOk) problems.push("sha256 mismatch");
  return { pass: problems.length === 0, problems };
}
