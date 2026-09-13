// apps/api/scripts/bench/gen/__tests__/insert.batch.test.ts
// M1/S10 回归：生成器跨批（>BATCH=5000 行）写入时，记录 id/createdAt 必须用全局下标，
// 不能在每个 5000 行分片内从 0 重新编号（旧实现第二批 recId 从 1 起，与第一批主键撞 UNIQUE）。
// 这是「300 行单批烟测通过、上万行才崩」的批偏移沉默错误，故用真实迁移库跨两批锁定。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";
import { Rng, resetIds } from "../prng.js";
import { buildIdentities, buildNarrowShape } from "../schema.js";
import { genNarrowRow, type RowSpec } from "../rows.js";
import { populate, recId } from "../insert.js";

const BATCH = 5000;
const N = BATCH + 1000; // 6000：强制跨两批，第二批 1000 行。

let tmpDir: string;
let dbFile: string;
let raw: Database.Database;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-gen-batch-"));
  dbFile = path.join(tmpDir, "g.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(),
    stdio: "ignore",
    env: process.env,
  });
  raw = new Database(dbFile);
});

afterAll(() => {
  raw?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("gen/insert 跨批全局下标", () => {
  it("6000 行跨两批写入不撞主键，且 id/createdAt 用全局编号", () => {
    resetIds(1);
    const identity = buildIdentities();
    const shape = buildNarrowShape(identity);

    const rng = new Rng(20260913);
    const opts = { softDeleteRate: 0.05, longTextRate: 0.1, dirtyRate: 0.005 };
    const mainRows: RowSpec[] = [];
    for (let i = 0; i < N; i++) mainRows.push(genNarrowRow(shape, rng, i, opts));
    const linkRng = new Rng((20260913 ^ 0x9e3779b9) >>> 0);

    // 修复前这里第二批首批 id 即 rec_m000...001，与第一批撞 UNIQUE，直接抛 SQLITE_CONSTRAINT_PRIMARYKEY。
    const result = populate(
      raw,
      shape,
      identity.ownerId,
      { mainRows, peerRows: [], rng: linkRng },
      false,
      "rec_m",
      "rec_p",
    );

    const counts = raw
      .prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT id) AS d FROM records WHERE "tableId"=?`)
      .get(shape.mainTableId) as { n: number; d: number };
    expect(counts.n).toBe(N);
    expect(counts.d).toBe(N); // 无任何重复主键（撞键会在写入期直接抛，这里再双保险）
    expect(result.live + result.softDeleted).toBe(N);

    // 第二批首行（全局下标 5000）必须是全局编号，而不是重新从 1 开始。
    const firstOfSecondBatch = recId("rec_m", BATCH);
    const row = raw.prepare(`SELECT id, "createdAt" FROM records WHERE id=?`).get(firstOfSecondBatch) as
      | { id: string; createdAt: number }
      | undefined;
    expect(row, `第二批首行 ${firstOfSecondBatch} 应存在（全局下标编号）`).toBeTruthy();
    // createdAt 同样按全局下标分桶：BASE_MS + floor(5000/3)，与首批任何记录的桶错开。
    const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");
    expect(row!.createdAt).toBe(BASE_MS + Math.floor(BATCH / 3));

    // 全局首行与末行都在，且末行编号为 N-1（证明整段 0..N-1 连续无回绕）。
    const ends = raw
      .prepare(
        `SELECT
           SUM(CASE WHEN id=? THEN 1 ELSE 0 END) AS firstHit,
           SUM(CASE WHEN id=? THEN 1 ELSE 0 END) AS lastHit
         FROM records`,
      )
      .get(recId("rec_m", 0), recId("rec_m", N - 1)) as { firstHit: number; lastHit: number };
    expect(ends.firstHit).toBe(1);
    expect(ends.lastHit).toBe(1);
  });
});
