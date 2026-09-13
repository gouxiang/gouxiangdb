// readyz 探针连接生命周期回归（M1/S9 生产缺陷捕获）：
//
// 缺陷：readyz 的 dbWritable 探针曾在【每次请求末 dispose】关闭其独立 better-sqlite3 连接。
// 启动探针（systemd/k8s）几乎总在 Prisma 建库后、其它常驻只读连接建立前到达；该短连接
// close 时会被 SQLite 当作"最后一个连接"，自动 checkpoint 并 unlink -wal/-shm，而 Prisma
// 引擎仍持有旧 wal，导致其首个写事务 SQLITE_IOERR_FSYNC(extended 522)。
//
// 不变式（与库大小无关，小库同样会被 unlink，仅"后续写是否报错"受 checkpoint 窗口影响）：
// Prisma 已持库并处于 WAL 时，任意次 readyz 评估 + dispose 后，-wal/-shm 必须仍在，
// 且 Prisma 随后的写必须成功。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

let tmpDir: string;
let dbFile: string;
let prisma: PrismaClient;
let mod: {
  createDefaultDeps: typeof import("../readiness.js")["createDefaultDeps"];
  runChecks: typeof import("../readiness.js")["runChecks"];
  closeProbeConn: typeof import("../readiness.js")["closeProbeConn"];
};
let dbReady: Promise<void>;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-readyz-wal-"));
  dbFile = path.join(tmpDir, "p.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.GX_DATA_DIR = tmpDir; // uploadsWritable 探针写入隔离目录
  delete process.env.NODE_ENV; // 让 db.js 走正常 PRAGMA WAL 初始化
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  mod = await import("../readiness.js");
  dbReady = (await import("../../db.js")).dbReady;
  await dbReady;
}, 120000);

afterAll(async () => {
  mod?.closeProbeConn();
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readyz 探针不得关闭/卸载 Prisma 正在使用的 WAL", () => {
  it("评估 + dispose 后 -wal/-shm 仍存在（探针连接常驻，未成为末连接）", async () => {
    const deps = mod.createDefaultDeps();
    await mod.runChecks(deps);
    // 探针连接活动期间 WAL 共享内存必然建立；旧实现 dispose 会 close 它并 unlink sidecar。
    expect(fs.existsSync(`${dbFile}-shm`)).toBe(true);
    deps.dispose();
    // 常驻修复后：dispose 不关连接，shm/wal 必须仍在。
    expect(fs.existsSync(`${dbFile}-shm`)).toBe(true);
    expect(fs.existsSync(`${dbFile}-wal`)).toBe(true);

    // 再来一轮：重复探测也不得在请求末卸载 WAL。
    const again = mod.createDefaultDeps();
    await mod.runChecks(again);
    again.dispose();
    expect(fs.existsSync(`${dbFile}-shm`)).toBe(true);
    expect(fs.existsSync(`${dbFile}-wal`)).toBe(true);
  });

  it("探针评估后 Prisma 引擎的写事务仍成功（无 522 IOERR）", async () => {
    const deps = mod.createDefaultDeps();
    await mod.runChecks(deps);
    deps.dispose();
    // 无害写：触发真实事务与 fsync，原缺陷在此抛 SQLITE_IOERR(522)。
    await expect(
      prisma.$executeRawUnsafe('UPDATE users SET "displayName"="displayName" WHERE 1=0'),
    ).resolves.toBe(0);
  });
});
