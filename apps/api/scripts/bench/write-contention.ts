// apps/api/scripts/bench/write-contention.ts
// M1/S1 最小写并发对抗（S9 压测脚手架雏形）。
//
// 在一个临时 SQLite 库上：迁移建表 → 建 base/table/field → 20 个并发工作单元，
// 每个单元在【单个交互事务】内 create + update 一条记录（只用传入 tx，不再入队）。
//
// 用法（两态分别起进程，队列开关在 db.ts 导入时由 env 解析）：
//   GX_M1_WRITE_QUEUE=on  pnpm tsx scripts/bench/write-contention.ts
//   GX_M1_WRITE_QUEUE=off pnpm tsx scripts/bench/write-contention.ts
//
// 判定：
//   - on  ：成功或业务 4xx 均可，但 SQLITE_BUSY(5)/SQLITE_LOCKED 次数必须为 0，否则退出码 1；
//   - off ：旁路队列直接打交互事务，仅如实报告 BUSY/LOCKED 次数（A/B 对照的 B，不据此失败）。
//
// 说明：db.ts 已设置 busy_timeout=5000，SQLite 单连接下 off 态通常不抛裸 SQLITE_BUSY，
// 而是多个交互事务在驱动侧排队、超过 Prisma 默认 5s 交互超时后整事务失败
// （2026-09-13 本机实测 off：success=9 / otherErrors=11，均为 transaction timeout，
// 活记录数=9，失败事务整体回滚；on：success=20 / 0 BUSY / 0 其他错误 / 61ms）。
// 两种报错都是「并发多语句写失败」这一既有病灶的表现，脚本如实报告，不预设结果。
// S9 将扩展为多形态、可配并发、延迟采样的完整 harness。

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const MODE = process.env.GX_M1_WRITE_QUEUE === "off" ? "off" : "on";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-contention-"));
const dbFile = path.join(tmpDir, "contention.db");
const dbUrl = `file:${dbFile}`;
process.env.DATABASE_URL = dbUrl;

// 在动态 import db.ts 之前先迁移（CLI 用同一 DATABASE_URL）
execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});

const prisma = new PrismaClient({ log: ["error"] });

async function seed(): Promise<{ tableId: string }> {
  const base = await prisma.base.create({ data: { name: "contention", createdBy: "bench" } });
  const table = await prisma.table.create({
    data: { baseId: base.id, name: "t", primaryFieldId: "", createdBy: "bench" },
  });
  await prisma.field.create({
    data: { tableId: table.id, name: "名称", type: "singleLineText", order: 0 },
  });
  return { tableId: table.id };
}

function isBusyError(e: unknown): boolean {
  const code = (e as { code?: string })?.code ?? "";
  const msg = e instanceof Error ? e.message : String(e);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" || /SQLITE_BUSY|database is locked/i.test(msg);
}

async function main(): Promise<void> {
  // 动态导入：确保上面设置的 DATABASE_URL / GX_M1_WRITE_QUEUE 已就位
  const { withWriteTx, dbReady } = await import("../../src/db.js");
  await dbReady;

  const { tableId } = await seed();

  const started = Date.now();
  let ok = 0;
  let busy = 0;
  let other = 0;
  const otherMessages: string[] = [];

  const worker = async (i: number): Promise<void> => {
    const task = async (tx: typeof prisma) => {
      const rec = await tx.record.create({
        data: { tableId, fields: "{}", createdBy: "bench", updatedBy: "bench" },
      });
      // 制造极短的事务持有窗口，让并发更可能撞锁
      await new Promise((r) => setTimeout(r, 2));
      await tx.record.update({
        where: { id: rec.id },
        data: { fields: JSON.stringify({ name: `r${i}` }) },
      });
    };
    try {
      if (MODE === "on") {
        await withWriteTx("bench.contention", (tx) => task(tx as typeof prisma));
      } else {
        await prisma.$transaction((tx) => task(tx as typeof prisma));
      }
      ok += 1;
    } catch (e) {
      if (isBusyError(e)) busy += 1;
      else {
        other += 1;
        otherMessages.push(e instanceof Error ? e.message : String(e));
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  const elapsedMs = Date.now() - started;

  const liveCount = await prisma.record.count({ where: { tableId } });
  const summary = {
    mode: MODE,
    concurrency: CONCURRENCY,
    success: ok,
    sqliteBusyOrLocked: busy,
    otherErrors: other,
    liveRecords: liveCount,
    elapsedMs,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (otherMessages.length > 0) console.log("other error sample:", otherMessages.slice(0, 3));

  await prisma.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (MODE === "on" && busy > 0) {
    console.error("FAIL: write queue enabled but observed SQLITE_BUSY/LOCKED");
    process.exit(1);
  }
  if (liveCount !== ok) {
    console.error(`FAIL: live records ${liveCount} != success ${ok}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
