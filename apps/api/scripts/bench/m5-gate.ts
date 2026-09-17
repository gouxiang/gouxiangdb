#!/usr/bin/env node
// apps/api/scripts/bench/m5-gate.ts
// M5/S13 规模门便携压测器（一条命令跑完，幂等、可中断、产物落盘）。
//
//   npx tsx scripts/bench/m5-gate.ts --out /tmp/m5-gate-<host>.json \
//     [--sizes 1000,10000,100000] [--dims 512,1024,1536] [--rounds 10] \
//     [--mode hybrid|fts] [--k 100] [--scope-caps 5000] \
//     [--seed 20260917] [--data-dir /tmp] [--min-free-mb 256] [--target-p95-ms 500] \
//     [--keep-db] [--force]
//
// 三个可复现杠杆（对应 §13「超档给杠杆证据」）：
//   --mode fts     关向量（仅关键词）——"关向量"杠杆；
//   --k <perRoute> 调每路召回上限——"调 k"杠杆；
//   --scope-caps a,b,c 一次扫多个 scope 节点上限——"收紧 scope"杠杆（产物按 cap 分档）。
//
// 测什么（对齐 §13）：混合检索(FTS+vec+RRF/boost) p95(默认十轮) + p50/min/max + warm RSS 峰值 +
// 库文件大小 + EXPLAIN「无先全量召回」断言 + 分阶段耗时 + 线性外推可流畅 chunk 上限。
// 口径为**参考画像，非硬 500ms 承诺**；只测 search.db 召回+融合核心（不起 HTTP/主库/authz）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectMachineSpec } from "./m5-spec.js";
import { renderMarkdown } from "./m5-report.js";
import { runCombo } from "./m5-combo.js";
import {
  parseBenchArgs, parseNumberList, pointsAtCap, primaryCap, smoothChunkLimit, type SmoothLimit,
} from "./m5-bench-lib.js";
import type { BenchMode, GateOptions, GateReport } from "./m5-types.js";

const DEFAULT_SIZES = [1000, 10000, 100000];
const DEFAULT_DIMS = [512, 1024, 1536];
const DEFAULT_SCOPE_CAPS = [5000];

function parseMode(raw: string | undefined): BenchMode {
  return raw === "fts" ? "fts" : "hybrid";
}

/** scope-caps：优先 `--scope-caps a,b,c`；回退 `--scope-cap N`（向后兼容）；再回退默认。 */
function parseScopeCaps(cli: Record<string, string>): number[] {
  if (cli["scope-caps"]) return parseNumberList(cli["scope-caps"], DEFAULT_SCOPE_CAPS);
  if (cli["scope-cap"]) return parseNumberList(cli["scope-cap"], DEFAULT_SCOPE_CAPS);
  return DEFAULT_SCOPE_CAPS;
}

/** 主口径：scope-caps 的最大值（外推/Tier-S 用，见 m5-bench-lib.primaryCap）。 */

export async function runGate(o: GateOptions): Promise<GateReport> {
  const spec = collectMachineSpec();
  const combos = [];
  for (const size of o.sizes) {
    for (const dim of o.dims) combos.push(await runCombo(size, dim, o));
  }
  const primary = primaryCap(o.scopeCaps);
  const primaryDim = o.dims[0] ?? 512;
  const smoothLimit: SmoothLimit = smoothChunkLimit(pointsAtCap(combos, primary, primaryDim), o.targetP95Ms);
  const tierSCombos = combos.filter((c) => c.chunks <= 100_000 && c.scopes);
  const p95s = tierSCombos
    .map((c) => c.scopes!.find((s) => s.cap === primary)?.rounds.p95Ms)
    .filter((v): v is number => v !== undefined);
  const worst = p95s.length > 0 ? Math.max(...p95s) : null;
  return {
    generatedAt: new Date().toISOString(),
    generator: "scripts/bench/m5-gate.ts",
    mode: `in-process ${o.mode === "fts" ? "keyword-only" : "hybrid"} recall (${o.mode === "fts" ? "FTS" : "FTS+vec KNN+RRF/boost"}) over real search.db; no HTTP/main-DB/authz`,
    config: {
      sizes: o.sizes, dims: o.dims, rounds: o.rounds, seed: o.seed,
      targetP95Ms: o.targetP95Ms, scopeCaps: o.scopeCaps, benchMode: o.mode, k: o.perRoute,
    },
    machine: spec,
    combos,
    smoothLimit,
    tierS: {
      maxChunk: 100_000,
      smooth: worst !== null && worst <= o.targetP95Ms,
      note: worst === null
        ? "Tier-S 档位无有效样本"
        : `1万–10万（初期 NAS 真实区间，主口径 cap=${primary}）最差 p95=${worst.toFixed(1)}ms，目标 ${o.targetP95Ms}ms`
          + ` -> ${worst <= o.targetP95Ms ? "达标" : "超阈值（参考画像下需控制 N / 或走关键词路）"}`,
    },
    notes: [
      "参考画像口径：非硬 500ms 承诺；由 (chunks,p95) 线性外推的可流畅上限为估算。",
      "测的是 search.db 召回+融合核心（不起 HTTP/主库/authz）；scope=生成节点前 cap 个（最坏上界 JOIN）。",
      "arm64 本次不做真机（仅 CI 交叉构建冒烟）；本报告不含 arm 性能数字。",
      "本机开发机数字仅留档；Tier-L 结论以真机 x86_64 报告为准。",
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
    scopeCaps: parseScopeCaps(cli),
    mode: parseMode(cli.mode),
    perRoute: Number(cli.k) > 0 ? Number(cli.k) : 100,
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
