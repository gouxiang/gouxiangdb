// apps/api/src/ops/__tests__/backup-uploads.test.ts
// 备份脚本（scripts/backup/online-backup.mjs）的 uploads 覆盖测试：真跑脚本、真打包 tar。
//
// 为什么单独一个文件：附件外置后 uploads 里是用户真实文件，备份"看起来成功但一个文件
// 都没打包"是最危险的失效——它不会报错、只在真要恢复那一刻才暴露。脚本本身不在 src 下
// （fpk 里随包分发），只能靠子进程真跑来验。
//
// 覆盖三条：
//   1. 口径一致：manifest.uploads.root 就是脚本实际打包的那个目录（与 config.ts 同口径）；
//   2. 漏备告警：目录缺失/为空而库里有用着的附件时，必须响（而不是静默返回 null）；
//   3. 保留裁剪：旧 db 被裁时，同批 uploads tar 一并删除（否则磁盘被 tar 静默吃满）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ops/__tests__ → ../../.. = apps/api
const apiRoot = path.resolve(here, "../../..");
const script = path.join(apiRoot, "scripts", "backup", "online-backup.mjs");

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gx-backup-uploads-"));
});
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 造一个能被脚本校验通过的源库：_prisma_migrations 一行 + attachments 一行。 */
function makeSourceDb(file: string, attachmentRows = 1): void {
  const db = new Database(file);
  db.exec("CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY, migration_name TEXT, finished_at TEXT, rolled_back_at TEXT)");
  db.exec('CREATE TABLE "attachments" (id TEXT PRIMARY KEY, "deletedAt" DATETIME)');
  db.prepare("INSERT INTO _prisma_migrations VALUES (?,?,?,?)")
    .run("m1", "20261009010000_attachments", new Date().toISOString(), null);
  for (let i = 0; i < attachmentRows; i += 1) {
    db.prepare('INSERT INTO "attachments" VALUES (?,?)').run(`att${i}`, null);
  }
  db.close();
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runBackup(env: Record<string, string>): RunResult {
  const r = spawnSync(process.execPath, [script], {
    cwd: apiRoot,
    // 干净环境：不带本机 .env / DATABASE_URL 等，避免测试之间互相污染。
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", ...env },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readManifest(backupDir: string, stamp: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(backupDir, "daily", `app-${stamp}.manifest.json`), "utf8"));
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

describe("备份覆盖 uploads", () => {
  it("UPLOAD_ROOT 明确设置：tar 真实产出，manifest 记录的是同一个目录", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "case1-"));
    const dbFile = path.join(dir, "app.db");
    const uploadRoot = path.join(dir, "uploads");
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(uploadRoot, { recursive: true });
    fs.writeFileSync(path.join(uploadRoot, "a.txt"), "hello");
    makeSourceDb(dbFile);

    const r = runBackup({
      DATABASE_URL: `file:${dbFile}`,
      UPLOAD_ROOT: uploadRoot,
      BACKUP_DIR: backupDir,
    });
    expect(r.code, r.stderr).toBe(0);

    const stamp = todayStamp();
    expect(fs.existsSync(path.join(backupDir, "daily", `uploads-${stamp}.tar`))).toBe(true);
    const manifest = readManifest(backupDir, stamp);
    // 关键：manifest 里写的 root 必须就是实际被打包的目录（运维据此核对口径）。
    expect(manifest.uploads.root).toBe(uploadRoot);
    expect(manifest.uploads.file).toBe(`uploads-${stamp}.tar`);
    expect(manifest.uploads.bytes).toBeGreaterThan(0);
    // 附件行纳入计数对账（只验行，文件一致性由 uploads 段负责）。
    expect(manifest.database.counts.attachments).toBe(1);
  });

  it("未设 UPLOAD_ROOT：按 GX_DATA_DIR/uploads 解析（与 config.ts 同口径）而非 <api>/uploads", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "case2-"));
    const dbFile = path.join(dir, "app.db");
    const dataDir = path.join(dir, "data");
    const backupDir = path.join(dir, "backups");
    fs.mkdirSync(dataDir, { recursive: true });
    makeSourceDb(dbFile);

    const r = runBackup({
      DATABASE_URL: `file:${dbFile}`,
      GX_DATA_DIR: dataDir,
      BACKUP_DIR: backupDir,
    });
    expect(r.code, r.stderr).toBe(0);
    const expectedRoot = path.join(dataDir, "uploads");
    // 目录不存在 → 明确告警，且 manifest 如实记录"这次没打包到文件"。
    expect(r.stderr).toContain("uploads 目录不存在");
    expect(r.stderr).toContain(expectedRoot);
    // 库里有用着的附件却没打包 → 再响一次（这才是会丢用户文件的那种静默失败）。
    expect(r.stderr).toContain("不在本次备份内");
    const manifest = readManifest(backupDir, todayStamp());
    expect(manifest.uploads.root).toBe(expectedRoot);
    expect(manifest.uploads.file).toBeNull();
  });

  it("保留裁剪：旧 db 与其同批 uploads tar 一并删除（tar 不会静默堆积）", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "case3-"));
    const dbFile = path.join(dir, "app.db");
    const uploadRoot = path.join(dir, "uploads");
    const backupDir = path.join(dir, "backups");
    const dailyDir = path.join(backupDir, "daily");
    fs.mkdirSync(uploadRoot, { recursive: true });
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(path.join(uploadRoot, "a.txt"), "hello");
    makeSourceDb(dbFile);

    // 造 10 个不同日期的旧份（超过 daily 7 与 weekly 4 的保留窗口），各带一个 tar。
    const oldStamps: string[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const stamp = `202606${String(i).padStart(2, "0")}`;
      oldStamps.push(stamp);
      fs.writeFileSync(path.join(dailyDir, `app-${stamp}.db`), "");
      fs.writeFileSync(path.join(dailyDir, `uploads-${stamp}.tar`), "");
    }

    const r = runBackup({
      DATABASE_URL: `file:${dbFile}`,
      UPLOAD_ROOT: uploadRoot,
      BACKUP_DIR: backupDir,
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("保留裁剪");

    const pruned = oldStamps.filter((s) => !fs.existsSync(path.join(dailyDir, `app-${s}.db`)));
    expect(pruned.length).toBeGreaterThan(0);
    for (const s of pruned) {
      // 同一批的 tar 必须跟着走，否则 db 没了、tar 还在 → 磁盘只涨不落。
      expect(fs.existsSync(path.join(dailyDir, `uploads-${s}.tar`))).toBe(false);
    }
  });
});
