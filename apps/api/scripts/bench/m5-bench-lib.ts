// apps/api/scripts/bench/m5-bench-lib.ts
// M5/S13 规模门纯函数层（零 IO，可单测）：族比例规划、内存守卫、线性外推求"可流畅 chunk 上限"、
// EXPLAIN「无先全量召回」断言、命令行解析、规模标签。压测执行物（m5-gen/m5-gate）只做 IO 编排。
//
// 复用于 M1/S9 的 percentile/summarize（stats.ts）——本层不再重复统计原语。

import { summarize, percentile, type Percentiles } from "./stats.js";

export type BenchFamily = "record" | "doc" | "canvas";

/** 三族按比例分配 chunk 目标（record 重、doc 中、canvas 轻；§4.6 三族内容口径）。 */
export const DEFAULT_FAMILY_WEIGHTS: Readonly<Record<BenchFamily, number>> = {
  record: 0.6, doc: 0.3, canvas: 0.1,
};

export function planFamilyMix(
  totalChunks: number,
  weights: Readonly<Record<BenchFamily, number>> = DEFAULT_FAMILY_WEIGHTS,
): Record<BenchFamily, number> {
  const families: BenchFamily[] = ["record", "doc", "canvas"];
  const sum = families.reduce((a, f) => a + weights[f], 0);
  const out = {} as Record<BenchFamily, number>;
  let assigned = 0;
  for (let i = 0; i < families.length; i++) {
    const f = families[i]!;
    if (i === families.length - 1) {
      out[f] = Math.max(0, totalChunks - assigned); // 末族收口，保证三族之和恰为 totalChunks
    } else {
      out[f] = Math.floor((totalChunks * weights[f]) / sum);
      assigned += out[f];
    }
  }
  return out;
}

/** 向量原始字节账：N × dim × 4（float32）；用于内存守卫与报告"存储账"。 */
export function estimateVectorBytes(chunks: number, dim: number): number {
  return chunks * dim * 4;
}

export interface MemoryVerdict {
  ok: boolean;
  reason?: "insufficient_memory";
  requiredBytes: number;
  availBytes: number;
  marginBytes: number;
}

/**
 * 建库前内存守卫：要求 可用内存 ≥ 向量字节 + 余量（默认 512MiB）。
 * 不足时调用方【跳过该档并给"降维/降规模"结论】，绝不硬上 OOM。
 */
export function decideMemory(
  availBytes: number,
  requiredBytes: number,
  marginBytes = 512 * 1024 * 1024,
): MemoryVerdict {
  const ok = availBytes >= requiredBytes + marginBytes;
  return {
    ok, requiredBytes, availBytes, marginBytes,
    ...(ok ? {} : { reason: "insufficient_memory" as const }),
  };
}

export interface LinearModel { a: number; b: number }
export interface SmoothLimit {
  /** 外推得到的"可流畅 chunk 上限"（p95 达 targetMs 处的 N）；不可外推时 null。 */
  limit: number | null;
  model: LinearModel;
  /** true=结果由已测点外推（非内插），说明它是参考画像不是承诺。 */
  extrapolated: boolean;
  note: string;
}

/** 最小二乘线性拟合 y = a + b·x（x=chunk 数，y=p95ms）。点 <2 时退化为常函数 b=0。 */
export function linearFit(points: ReadonlyArray<{ x: number; y: number }>): LinearModel {
  if (points.length === 0) return { a: 0, b: 0 };
  if (points.length === 1) return { a: points[0]!.y, b: 0 };
  const n = points.length;
  const sx = points.reduce((s, p) => s + p.x, 0);
  const sy = points.reduce((s, p) => s + p.y, 0);
  const sxx = points.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = points.reduce((s, p) => s + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { a: sy / n, b: 0 };
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b };
}

/**
 * 由已测 (chunks, p95) 点外推"可流畅 chunk 上限"：解 a + b·N = targetMs。
 * b ≤ 0（随规模不增或不可拟合）-> 上限记 null 且 note 说明"在已测规模内未达阈值"。
 */
export function smoothChunkLimit(
  points: ReadonlyArray<{ chunks: number; p95Ms: number }>,
  targetMs: number,
): SmoothLimit {
  const model = linearFit(points.map((p) => ({ x: p.chunks, y: p.p95Ms })));
  const maxTested = points.reduce((m, p) => Math.max(m, p.chunks), 0);
  const minTested = points.reduce((m, p) => Math.min(m, p.chunks), Infinity);
  if (points.length === 0) {
    return { limit: null, model, extrapolated: false, note: "无已测点" };
  }
  if (model.b <= 0) {
    return {
      limit: null, model, extrapolated: false,
      note: `p95 不随规模增长（斜率 ${model.b.toFixed(6)} ms/chunk），在已测最大 ${maxTested} chunk 内未达 ${targetMs}ms`,
    };
  }
  const limit = (targetMs - model.a) / model.b;
  if (limit < minTested) {
    return {
      limit: Math.round(limit), model, extrapolated: true,
      note: `拟合上限 ${Math.round(limit)} chunk 小于最小已测档 ${minTested}：最小档已超 ${targetMs}ms（需降维/缩小 scope）`,
    };
  }
  return {
    limit: Math.round(limit), model, extrapolated: true,
    note: `线性外推 a=${model.a.toFixed(2)}ms b=${model.b.toExponential(3)}ms/chunk；为目标值参考画像，非硬承诺`,
  };
}

export interface ExplainVerdict {
  ok: boolean;
  /** 未满足的断言（人类可读）。 */
  missing: string[];
}

/**
 * EXPLAIN 铁律断言（§4.5 :449）：三路召回收敛发生在结果产出之前。
 * FTS/LIKE 须见 temp_scope 覆盖索引；vec 须见 LIST SUBQUERY（白名单作 KNN 扫描约束）+ temp_scope。
 * 这里只判"计划文本是否含必需记号"，避免绑定 SQLite 版本的具体措辞。
 */
export function assertNoFullRecall(plans: {
  fts?: string[] | undefined;
  like?: string[] | undefined;
  vec?: string[] | undefined;
}): ExplainVerdict {
  const missing: string[] = [];
  const join = (xs?: string[]): string => (xs ?? []).join("\n");
  const ftsText = join(plans.fts);
  const likeText = join(plans.like);
  const vecText = join(plans.vec);
  if (plans.fts && plans.fts.length > 0) {
    if (!/temp_scope_/.test(ftsText)) missing.push("fts: 未见 temp_scope 收敛");
    if (!/fts_chunks/.test(ftsText)) missing.push("fts: 未见 fts_chunks 扫描");
  }
  if (plans.like && plans.like.length > 0 && !/temp_scope_/.test(likeText)) {
    missing.push("like: 未见 temp_scope 收敛");
  }
  if (plans.vec && plans.vec.length > 0) {
    if (!/vec_chunks/.test(vecText)) missing.push("vec: 未见 vec_chunks 扫描");
    if (!/LIST SUBQUERY/.test(vecText)) missing.push("vec: 白名单未下推为 LIST SUBQUERY（疑似先全量 KNN）");
    if (!/temp_scope_/.test(vecText)) missing.push("vec: 未见 temp_scope 收敛");
  }
  return { ok: missing.length === 0, missing };
}

/** 规模标签（1000/10000/100000 -> 1k/10k/100k）；非整千保持原值，避免 20k/50k 撞 10k。 */
export function scaleLabel(rows: number): string {
  if (rows >= 1_000_000) return "1m";
  if (rows >= 500_000) return "500k";
  if (rows >= 100_000) return "100k";
  if (rows >= 10_000) return "10k";
  if (rows >= 1_000) return "1k";
  return `${rows}`;
}

/** 档位 id 用标签（无碰撞）：整千 -> 20k/50k/100k，非整千 -> 原数字。 */
export function kiloLabel(rows: number): string {
  return rows >= 1000 && rows % 1000 === 0 ? `${rows / 1000}k` : `${rows}`;
}

/** `--k v` / 裸 `--k` 解析（下一 token 缺失或为 flag 时记 "true"，不吞后续 flag）。 */
export function parseBenchArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[a.slice(2)] = "true";
    } else {
      out[a.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

/** 逗号分隔整数列表解析（如 "1000,10000,100000"）；非法项丢弃并去重升序。 */
export function parseNumberList(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const seen = new Set<number>();
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (Number.isFinite(n) && n > 0) seen.add(Math.floor(n));
  }
  const out = [...seen].sort((a, b) => a - b);
  return out.length > 0 ? out : fallback;
}

export interface RoundStats {
  p95Ms: number;
  p50Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  rounds: number;
}

/** 采样毫秒序列 -> 百分位小结（复用 stats.summarize，保证与 M1 同口径）。 */
export function roundStats(ms: readonly number[]): RoundStats {
  const p: Percentiles = summarize([...ms]);
  return { p95Ms: p.p95, p50Ms: p.p50, minMs: p.min, maxMs: p.max, meanMs: p.mean, rounds: ms.length };
}

/** 取样本 95 分位（供报告里对"每轮命中数/慢轮"做二次汇总）。 */
export function p95(ms: readonly number[]): number {
  return percentile([...ms].sort((a, b) => a - b), 0.95);
}
