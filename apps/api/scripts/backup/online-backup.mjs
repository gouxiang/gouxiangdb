#!/usr/bin/env node
// apps/api/scripts/backup/online-backup.mjs
// 在线备份入口：better-sqlite3 .backup() 一致性快照 → integrity/迁移/计数校验 →
// uploads tar → sha256 + manifest → daily 7 / weekly 4 保留 →（可选）age X25519 异地加密。
// 用法：pnpm --filter @gx/api backup:online
// 环境：DATABASE_URL、BACKUP_DIR（默认 apps/api/.db-backups）、UPLOAD_ROOT、
//   BACKUP_ENCRYPT_OFFSITE(true 时 AGE_RECIPIENT 必填)、AGE_BIN(默认 age)、GX_OFFSITE_TARGET。
// 退出码：0 本地备份成功；2 快照/校验失败；3 异地加密配置或执行失败。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  parseStamp,
  readAppVersion,
  resolveDatabaseFile,
  selectForDeletion,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(apiRoot, "../..");
const prismaDir = path.join(apiRoot, "prisma");
const backupDir = process.env.BACKUP_DIR?.trim() || path.join(apiRoot, ".db-backups");
const uploadRoot = process.env.UPLOAD_ROOT?.trim() || path.join(apiRoot, "uploads");
const encryptOffsite = process.env.BACKUP_ENCRYPT_OFFSITE === "true";
const ageRecipient = process.env.AGE_RECIPIENT?.trim();
const ageBin = process.env.AGE_BIN?.trim() || "age";
const offsiteTarget = process.env.GX_OFFSITE_TARGET?.trim();

const KEY_TABLES = [
  "bases", "tables", "fields", "views", "records",
  "members", "users", "knowledge_bases", "kb_docs", "comments",
];

function fail(code, msg) {
  console.error(`[backup] ${msg}`);
  process.exit(code);
}

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

function ymd(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function pruneDir(dir, policy) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".db"))
    .map((file) => ({ file, date: parseStamp(file) }))
    .filter((e) => e.date);
  const deleted = [];
  for (const file of selectForDeletion(entries, policy)) {
    const dbPath = path.join(dir, file);
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(dbPath.replace(/\.db$/, ".manifest.json"), { force: true });
    deleted.push(file);
  }
  return deleted;
}

function makeUploadsTar(stamp) {
  if (!fs.existsSync(uploadRoot) || fs.readdirSync(uploadRoot).length === 0) return null;
  const tarFile = path.join(backupDir, "daily", `uploads-${stamp}.tar`);
  // -C 切到 uploads 父目录，按目录相对路径打包；macOS/BSD tar 与 GNU tar 均支持 -C。
  execFileSync("tar", ["-cf", tarFile, "-C", path.dirname(uploadRoot), path.basename(uploadRoot)], { stdio: "ignore" });
  return tarFile;
}

function runAgeEncrypt(stamp, dbFile, uploadsTar) {
  if (!encryptOffsite) return null;
  if (!ageRecipient) fail(3, "BACKUP_ENCRYPT_OFFSITE=true 但未提供 AGE_RECIPIENT（age1... 公钥）");
  let agePath = ageBin;
  try {
    execFileSync(ageBin, ["--version"], { stdio: "ignore" });
  } catch {
    fail(3, `找不到 age 二进制（AGE_BIN=${ageBin}）。请把随发布物 bin/age 放入 PATH 或设置 AGE_BIN`);
  }
  const spool = path.join(backupDir, "offsite", "spool");
  fs.mkdirSync(spool, { recursive: true });
  const outFile = path.join(spool, `offsite-${stamp}.tar.gz.age`);
  const tarArgs = ["-czf", "-", "-C", path.dirname(dbFile), path.basename(dbFile)];
  if (uploadsTar) tarArgs.push("-C", path.dirname(uploadsTar), path.basename(uploadsTar));
  const tarOut = execFileSync("tar", tarArgs);
  const enc = execFileSync(agePath, ["-r", ageRecipient, "-o", outFile], { input: tarOut });
  void enc;
  console.log(`[backup] 异地加密件：${outFile}`);
  return outFile;
}

function pushOffsite(ageFile) {
  if (!offsiteTarget || !ageFile) return false;
  try {
    if (offsiteTarget.includes(":")) {
      execFileSync("rsync", ["-a", ageFile, offsiteTarget.endsWith("/") ? offsiteTarget : `${offsiteTarget}/`], { stdio: "inherit" });
    } else {
      fs.cpSync(ageFile, path.join(offsiteTarget, path.basename(ageFile)));
    }
    return true;
  } catch (e) {
    console.warn(`[backup] 异地推送失败，加密件停留本地 spool：${e.message}`);
    return false;
  }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) fail(2, "未设置 DATABASE_URL");
  const sourceFile = resolveDatabaseFile(dbUrl, prismaDir);
  if (!fs.existsSync(sourceFile)) fail(2, `源数据库不存在：${sourceFile}`);

  const now = new Date();
  const stamp = ymd(now);
  const dailyDir = path.join(backupDir, "daily");
  fs.mkdirSync(dailyDir, { recursive: true });
  const dbFile = path.join(dailyDir, `app-${stamp}.db`);

  // 1) 在线一致性备份（WAL 自动合并，绝不 cp wal/shm）
  const src = new Database(sourceFile);
  try {
    await src.backup(dbFile);
  } finally {
    src.close();
  }

  // 2) 校验快照
  const info = inspect(dbFile);
  if (info.integrity !== "ok") fail(2, `快照 integrity_check=${info.integrity}`);
  const dbHash = sha256File(dbFile);

  // 3) uploads tar
  const uploadsTar = makeUploadsTar(stamp);

  // 4) manifest
  const manifest = {
    format: "gouxiangdb-backup-manifest",
    manifestVersion: 1,
    appVersion: readAppVersion(repoRoot),
    createdAt: now.toISOString(),
    database: {
      file: path.basename(dbFile),
      integrity: info.integrity,
      appliedMigrations: info.appliedMigrations,
      latestMigration: info.latestMigration,
      counts: info.counts,
      sha256: dbHash,
      bytes: fs.statSync(dbFile).size,
    },
    uploads: uploadsTar
      ? { file: path.basename(uploadsTar), sha256: sha256File(uploadsTar), bytes: fs.statSync(uploadsTar).size }
      : null,
  };
  fs.writeFileSync(dbFile.replace(/\.db$/, ".manifest.json"), JSON.stringify(manifest, null, 2));

  // 5) 周日另存 weekly（独立目录，保留 4 周）
  if (now.getUTCDay() === 0) {
    const weeklyDir = path.join(backupDir, "weekly");
    fs.mkdirSync(weeklyDir, { recursive: true });
    fs.cpSync(dbFile, path.join(weeklyDir, path.basename(dbFile)));
  }

  // 6) 保留裁剪
  const prunedDaily = pruneDir(dailyDir, { daily: 7, weekly: 4 });
  const prunedWeekly = pruneDir(path.join(backupDir, "weekly"), { daily: 4, weekly: 4 });

  console.log(`[backup] OK ${dbFile} integrity=ok migrations=${info.appliedMigrations} records=${info.counts.records ?? 0}`);
  console.log(`[backup] sha256 ${dbHash}`);
  if (uploadsTar) console.log(`[backup] uploads ${uploadsTar}`);
  if (prunedDaily.length || prunedWeekly.length) {
    console.log(`[backup] 保留裁剪 daily=${prunedDaily.length} weekly=${prunedWeekly.length}`);
  }

  // 7) 可选异地加密
  if (encryptOffsite) {
    const ageFile = runAgeEncrypt(stamp, dbFile, uploadsTar);
    const pushed = pushOffsite(ageFile);
    if (!pushed) console.warn("[backup] 加密件未推送异地（未配 GX_OFFSITE_TARGET 或推送失败），停留 spool");
  }
}

main().catch((e) => {
  console.error("[backup] 失败:", e instanceof Error ? e.message : e);
  process.exit(2);
});
