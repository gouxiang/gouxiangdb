// apps/api/scripts/bench/m5-types.ts
// M5/S13 压测器共享类型（供 m5-gate / m5-combo / m5-report 复用，避免相互 import 值形成环）。

import type { MachineSpec } from "./m5-spec.js";
import type { ExplainVerdict, RoundStats, SmoothLimit } from "./m5-bench-lib.js";
import type { StageTimings } from "./m5-measure.js";

export type BenchMode = "hybrid" | "fts";

/** 单个 scope-cap 档的测量结果（--scope-caps 一次扫多个值 -> 数组分档）。 */
export interface ScopeResult {
  /** 本档使用的 scope 节点上限。 */
  cap: number;
  scopeNodes: number;
  scopeTruncated: boolean;
  grantRows: number;
  warmup: number;
  rounds: RoundStats;
  hits: { fts: number; vec: number; fused: number };
  rss: { beforeBytes: number; peakBytes: number; afterBytes: number };
  stages: StageTimings;
  explain: ExplainVerdict;
}

export interface ComboResult {
  label: string;
  chunksRequested: number;
  chunks: number;
  dim: number;
  /** 检索模式：hybrid=关键词+向量；fts=仅关键词（"关向量"杠杆）。 */
  mode: BenchMode;
  /** 每路召回上限（k）。 */
  k: number;
  skipped?: { reason: "insufficient_memory" | "insufficient_disk"; detail: string };
  warnings?: string[];
  buildMs?: number;
  dbBytes?: number;
  /** 按 --scope-caps 顺序分档的测量结果。 */
  scopes?: ScopeResult[];
}

export interface GateReport {
  generatedAt: string;
  generator: string;
  mode: string;
  config: {
    sizes: number[]; dims: number[]; rounds: number; seed: number;
    targetP95Ms: number; scopeCaps: number[]; benchMode: BenchMode; k: number;
  };
  machine: MachineSpec;
  combos: ComboResult[];
  /** 主口径（最大 scope-cap）下的可流畅上限外推。 */
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
  /** scope 节点上限扫描档（一次多值；主口径取最大值）。 */
  scopeCaps: number[];
  /** 检索模式（hybrid | fts）。 */
  mode: BenchMode;
  /** 每路召回上限 k（perRoute）。 */
  perRoute: number;
  minFreeMb: number;
  /** 覆盖 RAM 守卫（dev 自测 / 已知机器空闲时）；磁盘守卫不可覆盖。 */
  allowLowMemory: boolean;
  keepDb: boolean;
  appDir: string;
  log?: (msg: string) => void;
}
