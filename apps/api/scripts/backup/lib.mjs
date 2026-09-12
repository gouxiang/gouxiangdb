// apps/api/scripts/backup/lib.mjs
// 备份/恢复脚本共享的纯逻辑（无 better-sqlite3、无副作用，可被两个 CLI 与 node 断言复用）：
// 路径解析、保留策略（daily 7 + weekly 4）、manifest 组装/比对。
// 与 src/ops/backup.ts 的同名算法保持一致（脚本运行时无法直接 import TS）。

import fs from "node:fs";
import path from "node:path";

// 从 DATABASE_URL 解析数据库文件绝对路径。
// 相对路径相对 prisma/ 目录解析（与 Prisma 对 SQLite 相对 schema 目录的解析一致）。
export function resolveDatabaseFile(databaseUrl, prismaDir) {
  const raw = databaseUrl.startsWith("file:")
    ? databaseUrl.slice("file:".length)
    : databaseUrl;
  const noQuery = raw.split("?")[0] ?? raw;
  return path.isAbsolute(noQuery) ? noQuery : path.resolve(prismaDir, noQuery);
}

// ISO 周键（同周同桶）。
function isoWeekKey(dt) {
  const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// 文件名形如 app-YYYYmmdd[-HHMMSS].db → UTC Date；无法解析返回 null。
export function parseStamp(file) {
  const m = file.match(/(\d{4})(\d{2})(\d{2})(?:-(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d, +(hh ?? 0), +(mi ?? 0), +(ss ?? 0)));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * 保留裁剪：输入 [{file,date}]，返回应删除的文件列表（保留集之外）。
 * 每日留当天最新一份取最近 7 日；每周优先周日（否则该周最新）取最近 4 周。
 */
export function selectForDeletion(entries, policy = { daily: 7, weekly: 4 }, now = new Date()) {
  const valid = entries
    .filter((e) => e.date.getTime() <= now.getTime() + 1000)
    .sort((a, b) => b.date.getTime() - a.date.getTime());

  const latestPerDay = new Map();
  for (const e of valid) {
    const k = e.date.toISOString().slice(0, 10);
    if (!latestPerDay.has(k)) latestPerDay.set(k, e);
  }
  const dailyKeep = [...latestPerDay.values()].slice(0, policy.daily);

  const perWeek = new Map();
  for (const e of valid) {
    const k = isoWeekKey(e.date);
    if (!perWeek.has(k)) perWeek.set(k, []);
    perWeek.get(k).push(e);
  }
  const reps = [];
  for (const list of perWeek.values()) {
    const sunday = list
      .filter((e) => e.date.getUTCDay() === 0)
      .sort((a, b) => b.date - a.date)[0];
    reps.push(sunday ?? list[0]);
  }
  reps.sort((a, b) => b.date - a.date);
  const weeklyKeep = reps.slice(0, policy.weekly);

  const keep = new Set([...dailyKeep, ...weeklyKeep].map((e) => e.file));
  return valid.filter((e) => !keep.has(e.file)).map((e) => e.file);
}

// 读包版本（用于 manifest.appVersion），容错返回 0.0.0-dev。
export function readAppVersion(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0-dev";
  }
}

// 恢复候选 manifest 与实测快照对账：返回 {pass, problems}。
export function verifyAgainstManifest(info, manifest, hashOk) {
  const problems = [];
  if (info.integrity !== "ok") problems.push(`integrity_check=${info.integrity}`);
  if (info.appliedMigrations !== manifest.database.appliedMigrations) {
    problems.push(`migrations ${info.appliedMigrations} != manifest ${manifest.database.appliedMigrations}`);
  }
  for (const [table, expected] of Object.entries(manifest.database.counts || {})) {
    if ((info.counts[table] ?? 0) !== expected) {
      problems.push(`count ${table} ${info.counts[table] ?? 0} != ${expected}`);
    }
  }
  if (hashOk === false) problems.push("sha256 mismatch");
  return { pass: problems.length === 0, problems };
}
