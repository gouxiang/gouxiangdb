// apps/api/scripts/bench/m5-combo.ts
// M5/S13 单档 (chunks, dim) 执行：内存/磁盘守卫 → 造库 → 按 scope-caps 逐档测量。
// 从 m5-gate.ts 抽出（守单文件 ≤300 行）；策略与 CLI 在 m5-gate，类型在 m5-types。

import fs from "node:fs";
import os from "node:os";
import { openSearchStore } from "../../src/domain/search/searchStore.js";
import { runRecall, toQueryBlob } from "../../src/domain/search/queryRecall.js";
import { buildSearchQueryPlan } from "../../src/domain/search/queryPlan.js";
import { generateSearchDb, defaultDbPath, queryVector } from "./m5-gen.js";
import { measureStages, oneHybridRound } from "./m5-measure.js";
import {
  assertNoFullRecall, decideMemory, estimateDiskBytes, estimateVectorBytes, kiloLabel, miB, roundStats,
} from "./m5-bench-lib.js";
import type { ComboResult, GateOptions, ScopeResult } from "./m5-types.js";

/** 磁盘可用字节（statfs 不可用时返回 null -> 跳过磁盘守卫）。 */
export function diskAvailBytes(dir: string): number | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** 跑一个 (chunks, dim) 组合：守卫 → 造库 → 每个 scope-cap 档预热 + R 轮 + EXPLAIN + 汇总。 */
export async function runCombo(size: number, dim: number, o: GateOptions): Promise<ComboResult> {
  const log = o.log ?? (() => { /* silent */ });
  const label = `${kiloLabel(size)}-${dim}d`;
  const out: ComboResult = { label, chunksRequested: size, chunks: 0, dim, mode: o.mode, k: o.perRoute };

  const ramNeed = 192 * 1024 * 1024 + 32 * 1024 * 1024;
  const ram = decideMemory(os.freemem(), ramNeed, o.minFreeMb * 1024 * 1024);
  if (!ram.ok && !o.allowLowMemory) {
    out.skipped = {
      reason: "insufficient_memory",
      detail: `free=${miB(ram.availBytes)}MiB < need=${miB(ram.requiredBytes)}MiB+margin=${miB(ram.marginBytes)}MiB`
        + `（本器流式写入，RSS 有界；若一次性载入全量向量需 ≈${miB(estimateVectorBytes(size, dim))}MiB）`
        + `；该档位需降维/降规模（如 dim 512 或 1 万 chunk），或确认机器空闲后用 --force 覆盖`,
    };
    log(`[m5-gate] SKIP ${label}: ${out.skipped.detail}`);
    return out;
  }
  if (!ram.ok && o.allowLowMemory) {
    out.warnings = [...(out.warnings ?? []),
      `RAM 守卫未过（free=${miB(ram.availBytes)}MiB < need+margin=${miB(ram.requiredBytes + ram.marginBytes)}MiB），已由 --force 覆盖`];
    log(`[m5-gate] WARN ${label}: RAM 守卫未过但 --force 覆盖`);
  }
  const diskNeed = estimateDiskBytes(size, dim);
  const diskAvail = diskAvailBytes(o.dataDir);
  if (diskAvail !== null && diskAvail < diskNeed + o.minFreeMb * 1024 * 1024) {
    out.skipped = {
      reason: "insufficient_disk",
      detail: `diskAvail=${miB(diskAvail)}MiB < need=${miB(diskNeed)}MiB+margin=${o.minFreeMb}MiB；该档位需降维/降规模或换数据盘`,
    };
    log(`[m5-gate] SKIP ${label}: ${out.skipped.detail}`);
    return out;
  }

  const dbPath = defaultDbPath(o.dataDir, `${label}-${o.mode}-k${o.perRoute}`);
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(dbPath + ext, { force: true }); } catch { /* ignore */ }
  }
  log(`[m5-gate] build ${label} mode=${o.mode} k=${o.perRoute} (chunks=${size}, dim=${dim}, diskNeed≈${miB(diskNeed)}MiB)…`);
  const gen = await generateSearchDb({ filePath: dbPath, appDir: o.appDir, totalChunks: size, dim, seed: o.seed });
  out.chunks = gen.totalChunks;
  out.buildMs = gen.buildMs;
  out.dbBytes = gen.dbBytes;

  const store = openSearchStore({ filePath: dbPath, appDir: o.appDir, tryLoadVec: true });
  try {
    if (!store.vecAvailable) {
      out.skipped = { reason: "insufficient_memory", detail: `vec0 未加载（${store.vecError ?? "unknown"}）：检查 glibc/arch 与 sqlite-vec 平台包` };
      return out;
    }
    const allGrants = store.db
      .prepare("SELECT DISTINCT tableNodeId, fieldId FROM field_grant")
      .all() as Array<{ tableNodeId: string; fieldId: string }>;
    // mode=fts -> 计划只跑关键词路（向量 enabled=false），等价"关向量"杠杆。
    const plan = buildSearchQueryPlan("季度报告", {
      mode: o.mode === "fts" ? "fts" : "auto", type: "all", limit: 20, perRoute: o.perRoute,
    });
    const qvec = toQueryBlob(queryVector(o.seed, dim));

    const scopes: ScopeResult[] = [];
    for (const cap of o.scopeCaps) {
      const scope = gen.nodeIds.slice(0, cap);
      const scopeSet = new Set(scope);
      const grants = allGrants.filter((g) => scopeSet.has(g.tableNodeId));
      const rssBefore = process.memoryUsage().rss;
      for (let i = 0; i < 3; i++) oneHybridRound(store.db, plan, scope, grants, qvec);
      const ms: number[] = [];
      let peak = process.memoryUsage().rss;
      let last = { fts: 0, vec: 0, fused: 0 };
      for (let i = 0; i < o.rounds; i++) {
        const r = oneHybridRound(store.db, plan, scope, grants, qvec);
        ms.push(r.ms);
        last = { fts: r.fts, vec: r.vec, fused: r.fused };
        peak = Math.max(peak, process.memoryUsage().rss);
      }
      const ex = runRecall(store.db, plan, scope, grants, { queryVector: qvec, explain: true });
      scopes.push({
        cap, scopeNodes: scope.length, scopeTruncated: gen.nodeIds.length > cap, grantRows: grants.length,
        warmup: 3, rounds: roundStats(ms), hits: last,
        rss: { beforeBytes: rssBefore, peakBytes: peak, afterBytes: process.memoryUsage().rss },
        stages: measureStages(store.db, plan, scope, grants, qvec),
        explain: assertNoFullRecall({ fts: ex.plans.fts, vec: ex.plans.vec }),
      });
      log(`[m5-gate] ${label} mode=${o.mode} k=${o.perRoute} cap=${cap}: p95=${scopes[scopes.length - 1]!.rounds.p95Ms.toFixed(1)}ms scope=${scope.length} hits fts=${last.fts} vec=${last.vec}`);
    }
    out.scopes = scopes;
  } finally {
    try { store.close(); } catch { /* ignore */ }
    if (!o.keepDb) {
      for (const ext of ["", "-wal", "-shm"]) {
        try { fs.rmSync(dbPath + ext, { force: true }); } catch { /* ignore */ }
      }
    }
  }
  return out;
}
