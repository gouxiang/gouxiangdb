// #1046b 启动自愈编排真库测试（临时库 + 真迁移，直接调 runScopeBackfillBoot，不经 HTTP）。
//
// 覆盖安全姿态：
//  1) GX_SCOPE_BACKFILL=off（enabled:false）→ disabled，零查询零写入；
//  2) 已一致库 → up-to-date，changed=0，不产生备份；
//  3) 存量缺口 → 先落 WAL 安全快照、再单事务补齐，投影落库；第二次跑 up-to-date（幂等，不再备份）；
//  4) 备份抛错 → backup-failed-skip，且【绝不动真实数据】（scope:role 仍 0 行，缺口保留待下次重试）；
//  5) :memory: → 无快照直接补齐（in-memory），不要求备份文件。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  createAuthzTempDb, resetTables, seedFixture,
} from "./scopeBackfillFixture.js";
import { runScopeBackfillBoot } from "../../../ops/scopeBackfillBoot.js";
import { computeScopeProjectionReconcile } from "../scopeProjectionReconcile.js";

let prisma: PrismaClient;
let cleanup: () => void;
let dbFile: string;
let prismaDir: string;

function freshBackupDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gx-boot-backup-"));
}

beforeAll(async () => {
  const db = createAuthzTempDb("gx-scope-boot-");
  prisma = db.prisma;
  cleanup = db.cleanup;
  // createAuthzTempDb 把 DATABASE_URL 设为绝对 file: URL；解析回物理文件用于断言。
  dbFile = process.env.DATABASE_URL!.replace(/^file:/, "").split("?")[0]!;
  prismaDir = path.dirname(dbFile);
}, 120000);

afterAll(async () => {
  await prisma.$disconnect();
  cleanup();
});

beforeEach(async () => {
  await resetTables(prisma);
});

const silent = () => {};

describe("runScopeBackfillBoot", () => {
  it("enabled:false → disabled，且不写任何投影", async () => {
    await seedFixture(prisma); // 即便有缺口也不动作
    const r = await runScopeBackfillBoot({
      prisma, databaseUrl: process.env.DATABASE_URL!, prismaDir,
      backupDir: freshBackupDir(), enabled: false, log: silent, warn: silent,
    });
    expect(r.status).toBe("disabled");
    expect(await prisma.authPolicy.count({ where: { reason: "scope:role" } })).toBe(0);
  });

  it("已一致库 → up-to-date，changed=0，不产生备份目录", async () => {
    // 干净库（resetTables 后无 scope 行）→ 计划 changed=0。
    const backupDir = freshBackupDir();
    const r = await runScopeBackfillBoot({
      prisma, databaseUrl: process.env.DATABASE_URL!, prismaDir,
      backupDir, log: silent, warn: silent,
    });
    expect(r.status).toBe("up-to-date");
    expect(r.changed).toBe(0);
    expect(fs.existsSync(path.join(backupDir, "scope-backfill"))).toBe(false);
  });

  it("存量缺口 → 先备份再补齐，投影落库；二次跑 up-to-date 且不再备份", async () => {
    await seedFixture(prisma);
    const backupDir = freshBackupDir();
    const fixedNow = new Date("2026-10-23T07:08:09.123Z");

    const r1 = await runScopeBackfillBoot({
      prisma, databaseUrl: process.env.DATABASE_URL!, prismaDir,
      backupDir, now: () => fixedNow, log: silent, warn: silent,
    });
    expect(r1.status).toBe("backed-up-and-applied");
    expect(r1.changed).toBeGreaterThan(0);
    expect(r1.applied?.created).toBe(r1.changed);

    // 快照确实落盘且非空。
    expect(fs.existsSync(r1.backupFile!)).toBe(true);
    expect(fs.statSync(r1.backupFile!).size).toBeGreaterThan(0);
    expect(r1.backupFile).toContain(`${path.sep}scope-backfill${path.sep}`);
    expect(path.basename(r1.backupFile!)).toMatch(/^app-\d{8}-\d{6}-\d{3}\.db$/);

    // 快照是补齐前的状态：其中 scope:role 投影应为 0 行。
    const Database = (await import("better-sqlite3")).default;
    const snap = new Database(r1.backupFile!, { readonly: true, fileMustExist: true });
    try {
      const c = snap.prepare("SELECT count(*) AS c FROM auth_policies WHERE reason='scope:role'").get() as { c: number };
      expect(c.c).toBe(0);
    } finally {
      snap.close();
    }

    // 现库已无缺口。
    expect(await computeScopeProjectionReconcile(prisma)).toEqual([]);

    // 幂等：第二次跑 up-to-date，备份目录里仍只有第一次那一个快照。
    const r2 = await runScopeBackfillBoot({
      prisma, databaseUrl: process.env.DATABASE_URL!, prismaDir,
      backupDir, now: () => fixedNow, log: silent, warn: silent,
    });
    expect(r2.status).toBe("up-to-date");
    expect(r2.changed).toBe(0);
    const snaps = fs.readdirSync(path.join(backupDir, "scope-backfill"));
    expect(snaps).toHaveLength(1);
  });

  it("备份失败 → backup-failed-skip，真实数据一根不碰，缺口保留", async () => {
    await seedFixture(prisma);
    const backupDir = freshBackupDir();
    const r = await runScopeBackfillBoot({
      prisma, databaseUrl: process.env.DATABASE_URL!, prismaDir,
      backupDir,
      backup: async () => {
        throw new Error("disk full (simulated)");
      },
      log: silent, warn: silent,
    });
    expect(r.status).toBe("backup-failed-skip");
    expect(r.changed).toBeGreaterThan(0);
    // 关键安全不变量：备份没成功就绝不写库。
    expect(await prisma.authPolicy.count({ where: { reason: "scope:role" } })).toBe(0);
    // 缺口仍在 → 下次启动可重新检出重试。
    expect(await computeScopeProjectionReconcile(prisma).then((d) => d.length)).toBeGreaterThan(0);
  });

  it(":memory: 库 → in-memory，无快照也能补齐", async () => {
    await seedFixture(prisma);
    const backupDir = freshBackupDir();
    const r = await runScopeBackfillBoot({
      // databaseUrl 只决定 dbFile 是否为 :memory:（进而决定要不要备份）；读写仍走注入的 prisma。
      prisma, databaseUrl: ":memory:", prismaDir,
      backupDir, log: silent, warn: silent,
    });
    expect(r.status).toBe("in-memory");
    expect(r.backupFile).toBeUndefined();
    expect(await computeScopeProjectionReconcile(prisma)).toEqual([]);
    expect(fs.existsSync(path.join(backupDir, "scope-backfill"))).toBe(false);
  });
});
