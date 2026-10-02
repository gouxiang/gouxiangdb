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
// uploadRoot 必须与运行时【同一口径】（config.ts:295-297：UPLOAD_ROOT → GX_DATA_DIR/uploads
// → 生产 /var/lib/gouxiangdb/uploads、开发 <api>/uploads）。
// 2026-10-02 修：此前这里兜底成 <api>/uploads，而 API 进程在生产（未设 UPLOAD_ROOT 时）
// 用的是 /var/lib/gouxiangdb/uploads —— 两侧不一致时 makeUploadsTar 会静默返回 null，
// 备份「成功」但一个附件文件都没打包（附件外置后即等于丢用户文件）。口径统一 + 缺失告警。
const dataDir = process.env.GX_DATA_DIR?.trim()
  || (process.env.NODE_ENV === "production" ? "/var/lib/gouxiangdb" : apiRoot);
const uploadRoot = process.env.UPLOAD_ROOT?.trim() || path.join(dataDir, "uploads");
const encryptOffsite = process.env.BACKUP_ENCRYPT_OFFSITE === "true";
const ageRecipient = process.env.AGE_RECIPIENT?.trim();
const ageBin = process.env.AGE_BIN?.trim() || "age";
const offsiteTarget = process.env.GX_OFFSITE_TARGET?.trim();

const KEY_TABLES = [
  "bases", "tables", "fields", "views", "records",
  "members", "users", "knowledge_bases", "kb_docs", "comments",
  // R2 附件外置：附件行（attachments）进 manifest 计数，恢复校验能发现「行数对不上」。
  // 注意这只是【行】的一致性；物理文件是否真的进了备份由下面的 uploads 段与告警负责。
  "attachments",
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
    // 同批 uploads tar 一并裁剪：db 被裁掉而 tar 永存会静默吃满磁盘
    //（附件外置后 uploads 体积从"头像级"变成"GB 级"，这个洞必须堵）。
    const stamp = /^app-(\d{8})(?:-\d{6})?\.db$/.exec(file)?.[1];
    if (stamp) fs.rmSync(path.join(dir, `uploads-${stamp}.tar`), { force: true });
    deleted.push(file);
  }
  return deleted;
}

/**
 * 统计在用附件行数（库里没有 attachments 表时返回 null，表示"未知"，
 * 老库未迁移属正常，不该被当成 0 而去告警）。
 */
function countAttachmentRows(dbFile) {
  try {
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT count(*) AS c FROM "attachments" WHERE "deletedAt" IS NULL').get();
      return typeof row?.c === "number" ? row.c : null;
    } finally {
      db.close();
      removeSidecars(dbFile);
    }
  } catch {
    return null;
  }
}

function makeUploadsTar(stamp) {
  if (!fs.existsSync(uploadRoot)) {
    console.warn(
      `[backup] WARN uploads 目录不存在：${uploadRoot}` +
        `（本次备份不含任何附件/头像文件。请核对 UPLOAD_ROOT 与 API 进程用的是同一目录）`,
    );
    return null;
  }
  if (fs.readdirSync(uploadRoot).length === 0) return null;
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
  // 漏备告警：库里有用着的附件、本次却没产出 uploads 包 = 用户文件不在备份里，
  // 这比"备份失败"更危险（备份看起来是成功的）。必须响，不能静默。
  const attachmentRows = countAttachmentRows(dbFile);
  if (!uploadsTar && attachmentRows) {
    console.warn(
      `[backup] WARN 库中有 ${attachmentRows} 条在用附件，但本次未产出 uploads 备份` +
        `（uploadRoot=${uploadRoot} 不存在或为空）——附件文件不在本次备份内！`,
    );
  }

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
      ? {
          file: path.basename(uploadsTar),
          // 真实来源目录写进 manifest：运维可据此核对"备份的 uploads 是不是应用实际写的那个"。
          root: uploadRoot,
          sha256: sha256File(uploadsTar),
          bytes: fs.statSync(uploadsTar).size,
        }
      : { file: null, root: uploadRoot },
  };
  fs.writeFileSync(dbFile.replace(/\.db$/, ".manifest.json"), JSON.stringify(manifest, null, 2));

  // 5) 周日另存 weekly（独立目录，保留 4 周）
  if (now.getUTCDay() === 0) {
    const weeklyDir = path.join(backupDir, "weekly");
    fs.mkdirSync(weeklyDir, { recursive: true });
    fs.cpSync(dbFile, path.join(weeklyDir, path.basename(dbFile)));
    // 附件外置后必须同批带上 uploads：只存 db 的周备份恢复出来，附件行都在、
    // 文件全丢（下载 404），比"没有这份备份"更坑。代价是周备份体积 ≈ db + uploads tar。
    if (uploadsTar) {
      const weeklyTar = path.join(weeklyDir, path.basename(uploadsTar));
      fs.cpSync(uploadsTar, weeklyTar);
      console.log(`[backup] weekly 含 uploads：${weeklyTar}`);
    }
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
