// apps/api/src/ops/__tests__/backup.test.ts
// 备份：时间戳解析/保留裁剪/manifest 对账纯函数 + 真实临时库在线备份→恢复一致性。

import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  backupDatabase,
  buildManifest,
  inspectSnapshot,
  parseStamp,
  selectRetention,
  sha256File,
  verifyAgainstManifest,
} from "../backup.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gx-backup-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe("parseStamp", () => {
  it("解析日期与带时间戳文件名（UTC）", () => {
    expect(parseStamp("app-20260913.db")?.toISOString().slice(0, 10)).toBe("2026-09-13");
    const withTime = parseStamp("app-20260913-020000.db");
    expect(withTime?.getUTCHours()).toBe(2);
    expect(parseStamp("garbage.db")).toBeNull();
  });
});

describe("selectRetention 保留策略", () => {
  const d = (y: number, m: number, d0: number, hh = 0) => new Date(Date.UTC(y, m - 1, d0, hh));
  const E = (file: string, date: Date) => ({ file, date });

  it("每日只留当天最新一份，保留最近 7 日", () => {
    const entries = [
      E("app-20260910-010000.db", d(2026, 9, 10, 1)),
      E("app-20260910-050000.db", d(2026, 9, 10, 5)), // 同日更晚，应留这份
      E("app-20260911.db", d(2026, 9, 11)),
      E("app-20260912.db", d(2026, 9, 12)),
    ];
    const keep = selectRetention(entries, { daily: 7, weekly: 4 }, d(2026, 9, 13));
    expect(keep.has("app-20260910-050000.db")).toBe(true);
    expect(keep.has("app-20260910-010000.db")).toBe(false);
    expect(keep.has("app-20260912.db")).toBe(true);
  });

  it("超过 7 日的旧份若落在保留的周末桶仍保留，否则裁剪", () => {
    // 构造 10 个不同日，最新为 2026-09-13（周日）
    const entries: Array<{ file: string; date: Date }> = [];
    for (let i = 0; i < 10; i += 1) {
      const dt = new Date(Date.UTC(2026, 8, 13 - i));
      entries.push(E(`app-${dt.toISOString().slice(0, 10).replace(/-/g, "")}.db`, dt));
    }
    const keep = selectRetention(entries, { daily: 7, weekly: 4 }, d(2026, 9, 13));
    // 最近 7 天（09-07..09-13）都在
    expect(keep.has("app-20260913.db")).toBe(true);
    expect(keep.has("app-20260907.db")).toBe(true);
    // 09-06（周日）作为上周周末代表应保留
    expect(keep.has("app-20260906.db")).toBe(true);
    // 09-04 既不在最近 7 日、也不是保留周的周末代表，应裁剪
    expect(keep.has("app-20260904.db")).toBe(false);
  });
});

describe("在线备份→快照校验（真实临时库）", () => {
  it("live 库 .backup() 后记录数/迁移数/integrity 一致，manifest 对账通过", async () => {
    const srcFile = path.join(tmpRoot, "src.db");
    const dstFile = path.join(tmpRoot, "out", "app-test.db");
    const src = new Database(srcFile);
    src.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, x TEXT)");
    src.exec("CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY, migration_name TEXT, finished_at TEXT, rolled_back_at TEXT)");
    const ins = src.prepare("INSERT INTO records (x) VALUES (?)");
    for (let i = 0; i < 23; i += 1) ins.run(`v${i}`);
    const mig = src.prepare(
      "INSERT INTO _prisma_migrations (id, migration_name, finished_at, rolled_back_at) VALUES (?,?,?,?)",
    );
    mig.run("m1", "20260904000000_init", new Date().toISOString(), null);
    mig.run("m2", "20260911233000_kbdoc_content_version", new Date().toISOString(), null);
    src.close();

    await backupDatabase(srcFile, dstFile);
    const info = inspectSnapshot(dstFile);
    expect(info.integrity).toBe("ok");
    expect(info.counts.records).toBe(23);
    expect(info.appliedMigrations).toBe(2);
    expect(info.latestMigration).toBe("20260911233000_kbdoc_content_version");

    const hash = sha256File(dstFile);
    const manifest = buildManifest({
      createdAt: new Date(),
      dbFileName: path.basename(dstFile),
      info,
      dbHash: hash,
      dbBytes: fs.statSync(dstFile).size,
    });
    expect(manifest.database.sha256).toBe(hash);

    // 用快照自身对账：PASS
    const ok = verifyAgainstManifest(info, manifest, true);
    expect(ok.pass).toBe(true);

    // 篡改计数模拟不一致：FAIL 且给出问题表
    const badManifest = {
      ...manifest,
      database: { ...manifest.database, counts: { ...manifest.database.counts, records: 999 } },
    };
    const bad = verifyAgainstManifest(info, badManifest, true);
    expect(bad.pass).toBe(false);
    expect(bad.problems.join(" ")).toContain("records");

    // 哈希不符：FAIL
    expect(verifyAgainstManifest(info, manifest, false).pass).toBe(false);
  });
});
