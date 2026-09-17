#!/usr/bin/env node
// apps/api/scripts/bench/m5-gate.ts
// M5/S13 规模门便携压测器（一条命令跑完，幂等、可中断、产物落盘）。
//
//   pnpm tsx scripts/bench/m5-gate.ts --out /tmp/m5-gate-<host>.json \
//     [--sizes 1000,10000,100000] [--dims 512,1024,1536] [--rounds 10] \
//     [--seed 20260917] [--data-dir /tmp] [--min-free-mb 256] [--target-p95-ms 500] \
//     [--scope-cap 5000] [--keep-db] [--force]
//
// 测什么（对齐 M5-implementation-plan §13）：
//   - 混合检索（FTS + vec KNN + RRF 融合）的 **p95（默认十轮）**、p50/min/max/mean；
//   - warm RSS（采样峰值）；库文件大小；EXPLAIN 断言「无先全量召回」（白名单下推为 KNN 扫描约束）；
//   - 由 (chunks, p95) 线性外推「可流畅 chunk 上限」——**参考画像，非硬 500ms 承诺**。
// 输入只有 search.db 召回+融合核心（不起 HTTP/主库/authz），这是便携、跨机可比的口径；
// 真机执行时在报告里注明。内存纪律：m5-gen 分批流式写入，RSS 有界；建库前做 RAM+磁盘守卫，
// 不足则跳过该档并给「需降维/降规模」结论。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openSearchStore } from "../../src/domain/search/searchStore.js";
import { runRecall, toQueryBlob } from "../../src/domain/search/queryRecall.js";
import { buildSearchQueryPlan } from "../../src/domain/search/queryPlan.js";
import { collectMachineSpec, type MachineSpec } from "./m5-spec.js";
import { renderMarkdown } from "./m5-report.js";
import { generateSearchDb, defaultDbPath, queryVector } from "./m5-gen.js";
import { measureStages, oneHybridRound, type StageTimings } from "./m5-measure.js";
import {
  assertNoFullRecall, decideMemory, estimateDiskBytes, estimateVectorBytes, kiloLabel,
  miB, parseBenchArgs, parseNumberList, roundStats, smoothChunkLimit,
  type ExplainVerdict, type RoundStats, type SmoothLimit,
} from "./m5-bench-lib.js";

const QUERY_TERM = "季度报告";
const DEFAULT_SIZES = [1000, 10000, 100000];
const DEFAULT_DIMS = [512, 1024, 1536];
/** 流式写入的内存基线（Node+better-sqlite3+批缓冲），与规模无关（不随 dim/chunks 增长）。 */
const STREAM_RAM_BASE = 192 * 1024 * 1024;

export interface ComboResult {
  label: string;
  chunksRequested: number;
  chunks: number;
  dim: number;
  skipped?: { reason: "insufficient_memory" | "insufficient_disk"; detail: string };
  warnings?: string[];
  buildMs?: number;
  dbBytes?: number;
  scopeNodes?: number;
  scopeTruncated?: boolean;
  grantRows?: number;
  warmup?: number;
  rounds?: RoundStats;
  hits?: { fts: number; vec: number; fused: number };
  rss?: { beforeBytes: number; peakBytes: number; afterBytes: number };
  /** 单次分阶段耗时（诊断：定位超线性在哪一段；非 10 轮均值，仅作归因）。 */
  stages?: StageTimings;
  explain?: ExplainVerdict;
}

export interface GateReport {
  generatedAt: string;
  generator: string;
  mode: string;
  config: { sizes: number[]; dims: number[]; rounds: number; seed: number; targetP95Ms: number; scopeCap: number };
  machine: MachineSpec;
  combos: ComboResult[];
  smoothLimit: SmoothLimit;
  tierS: { maxChunk: number; smooth: boolean; note: string };
  notes: string[];
}

export interface GateOptions {
  dataDir: string;
  outPath: string;
  sizes: number[];
  dims: number[];
  rounds: number;
  seed: number;
  targetP95Ms: number;
  scopeCap: number;
  minFreeMb: number;
  /** 覆盖 RAM 守卫（dev 自测 / 已知机器空闲时）；磁盘守卫不可覆盖。 */
  allowLowMemory: boolean;
  keepDb: boolean;
  appDir: string;
  log?: (msg: string) => void;
}

function diskAvailBytes(dir: string): number | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

/** 跑一个 (chunks, dim) 组合：守卫 → 造库 → 预热 → R 轮 → EXPLAIN → 汇总。 */
export async function runCombo(size: number, dim: number, o: GateOptions): Promise<ComboResult> {
  const log = o.log ?? (() => { /* silent */ });
  const label = `${kiloLabel(size)}-${dim}d`;
  const out: ComboResult = { label, chunksRequested: size, chunks: 0, dim };

  const ramNeed = STREAM_RAM_BASE + 32 * 1024 * 1024;
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
      `RAM 守卫未过（free=${miB(ram.availBytes)}MiB < need+margin=${miB(ram.requiredBytes + ram.marginBytes)}MiB），已由 --force 覆盖；RSS 峰值见报告（macOS freemem 因文件缓存会低估）`];
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

  const dbPath = defaultDbPath(o.dataDir, label);
  // 幂等：先清旧库三件再重建（可中断后重跑）。
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.rmSync(dbPath + ext, { force: true }); } catch { /* ignore */ }
  }
  log(`[m5-gate] build ${label} (chunks=${size}, dim=${dim}, diskNeed≈${miB(diskNeed)}MiB)…`);
  const gen = await generateSearchDb({ filePath: dbPath, appDir: o.appDir, totalChunks: size, dim, seed: o.seed });
  out.chunks = gen.totalChunks;
  out.buildMs = gen.buildMs;
  out.dbBytes = gen.dbBytes;
  const scope = gen.nodeIds.slice(0, o.scopeCap);
  out.scopeNodes = scope.length;
  out.scopeTruncated = gen.nodeIds.length > o.scopeCap;

  const store = openSearchStore({ filePath: dbPath, appDir: o.appDir, tryLoadVec: true });
  try {
    if (!store.vecAvailable) {
      out.skipped = { reason: "insufficient_memory", detail: `vec0 未加载（${store.vecError ?? "unknown"}）：检查 glibc/arch 与 sqlite-vec 平台包` };
      return out;
    }
    // scope 内字段白名单：直接取生成库的 field_grant（等价生产 scope.maskedTableFields 展开），
    // 只保留落在 scope 内的行，避免为 scope 外表的授权行白付 temp 表物化成本。
    const scopeSet = new Set(scope);
    const allGrants = store.db
      .prepare("SELECT DISTINCT tableNodeId, fieldId FROM field_grant")
      .all() as Array<{ tableNodeId: string; fieldId: string }>;
    const grantsForRecall = allGrants.filter((g) => scopeSet.has(g.tableNodeId));
    out.grantRows = grantsForRecall.length;
    const plan = buildSearchQueryPlan(QUERY_TERM, { mode: "auto", type: "all", limit: 20, perRoute: 100 });
    const qvec = toQueryBlob(queryVector(o.seed, dim));

    const rssBefore = process.memoryUsage().rss;
    for (let i = 0; i < 3; i++) oneHybridRound(store.db, plan, scope, grantsForRecall, qvec); // 预热（丢弃）
    out.warmup = 3;

    const ms: number[] = [];
    let peak = process.memoryUsage().rss;
    let last = { fts: 0, vec: 0, fused: 0 };
    for (let i = 0; i < o.rounds; i++) {
      const r = oneHybridRound(store.db, plan, scope, grantsForRecall, qvec);
      ms.push(r.ms);
      last = { fts: r.fts, vec: r.vec, fused: r.fused };
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    out.rounds = roundStats(ms);
    out.hits = last;
    out.stages = measureStages(store.db, plan, scope, grantsForRecall, qvec);
    out.rss = { beforeBytes: rssBefore, peakBytes: peak, afterBytes: process.memoryUsage().rss };

    const ex = runRecall(store.db, plan, scope, grantsForRecall, { queryVector: qvec, explain: true });
    out.explain = assertNoFullRecall({ fts: ex.plans.fts, vec: ex.plans.vec });
    log(`[m5-gate] ${label}: p95=${out.rounds.p95Ms.toFixed(1)}ms peakRSS=${miB(peak)}MiB db=${miB(gen.dbBytes)}MiB explain=${out.explain.ok ? "OK" : "FAIL:" + out.explain.missing.join(",")}`);
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

export async function runGate(o: GateOptions): Promise<GateReport> {
  const spec = collectMachineSpec();
  const combos: ComboResult[] = [];
  for (const size of o.sizes) {
    for (const dim of o.dims) combos.push(await runCombo(size, dim, o));
  }
  const primaryDim = o.dims[0] ?? 512;
  const points = combos
    .filter((c) => c.dim === primaryDim && c.rounds && !c.skipped)
    .map((c) => ({ chunks: c.chunks, p95Ms: c.rounds!.p95Ms }));
  const smoothLimit = smoothChunkLimit(points, o.targetP95Ms);
  const tierSCombos = combos.filter((c) => c.chunks <= 100_000 && c.rounds);
  const worst = tierSCombos.reduce<number | null>((m, c) => (m === null ? c.rounds!.p95Ms : Math.max(m, c.rounds!.p95Ms)), null);
  return {
    generatedAt: new Date().toISOString(),
    generator: "scripts/bench/m5-gate.ts",
    mode: "in-process hybrid recall (FTS+vec KNN+RRF/boost) over real search.db; no HTTP/main-DB/authz",
    config: { sizes: o.sizes, dims: o.dims, rounds: o.rounds, seed: o.seed, targetP95Ms: o.targetP95Ms, scopeCap: o.scopeCap },
    machine: spec,
    combos,
    smoothLimit,
    tierS: {
      maxChunk: 100_000,
      smooth: worst !== null && worst <= o.targetP95Ms,
      note: worst === null
        ? "Tier-S 档位无有效样本"
        : `1万–10万（初期 NAS 真实区间）最差 p95=${worst.toFixed(1)}ms，目标 ${o.targetP95Ms}ms -> ${worst <= o.targetP95Ms ? "流畅" : "超阈值（需降维/缩小 scope）"}`,
    },
    notes: [
      "参考画像口径：非硬 500ms 承诺；由 (chunks,p95) 线性外推的可流畅上限为估算。",
      "测的是 search.db 召回+融合核心（不起 HTTP/主库/authz）；scope=全部生成节点（≤scopeCap，最坏 JOIN）。",
      "arm64 本次不做真机（仅 CI 交叉构建冒烟）；本报告不含 arm 性能数字。",
      "本机开发机数字仅留档；Tier-L 结论以真机 2C4G x86_64 报告为准。",
    ],
  };
}

async function main(): Promise<void> {
  const cli = parseBenchArgs(process.argv.slice(2));
  const outPath = cli.out ?? path.join(process.cwd(), "artifacts", `m5-gate-${os.hostname()}.json`);
  const opts: GateOptions = {
    dataDir: cli["data-dir"] ?? os.tmpdir(),
    outPath,
    sizes: parseNumberList(cli.sizes, DEFAULT_SIZES),
    dims: parseNumberList(cli.dims, DEFAULT_DIMS),
    rounds: Number(cli.rounds) > 0 ? Number(cli.rounds) : 10,
    seed: Number.isFinite(Number(cli.seed)) ? Number(cli.seed) : 20260917,
    targetP95Ms: Number(cli["target-p95-ms"]) > 0 ? Number(cli["target-p95-ms"]) : 500,
    scopeCap: Number(cli["scope-cap"]) > 0 ? Number(cli["scope-cap"]) : 5000,
    minFreeMb: Number(cli["min-free-mb"]) > 0 ? Number(cli["min-free-mb"]) : 256,
    allowLowMemory: cli.force === "true",
    keepDb: cli["keep-db"] === "true",
    appDir: process.cwd(),
    log: (m) => console.log(m),
  };
  const report = await runGate(opts);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  const mdPath = outPath.replace(/\.json$/, "") + ".md";
  fs.writeFileSync(mdPath, renderMarkdown(report));
  console.log(`\n[m5-gate] 产物：${outPath}\n[m5-gate] 人读：${mdPath}`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked.endsWith("m5-gate.ts") || invoked.endsWith("m5-gate.js")) {
  main().catch((err) => {
    console.error("[m5-gate] 运行失败:", err);
    process.exit(1);
  });
}
