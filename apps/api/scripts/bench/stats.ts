// apps/api/scripts/bench/stats.ts
// M1/S9 压测统计原语（纯函数、无 IO，可单测）：百分位（最近秩法）、均值、吞吐、失败率、
// 每请求双计数均值与峰值 RSS。不引入第三方依赖。

export interface Sample {
  /** 客户端实测往返毫秒（fetch 发出到响应头返回）。 */
  clientMs: number;
  /** 服务端中间件 x-gx-serve-ms（不含网络）。 */
  serveMs: number;
  physicalSql: number;
  prismaCalls: number;
  rssBytes: number;
  ok: boolean;
  status: number;
  /** 是否客户端超时（AbortController）；超时是失败的一类但单列计数。 */
  timedOut: boolean;
}

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
}

/** 最近秩百分位：p 为 0..1；入参无需预排序（内部复制排序，不改原数组）。 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = Math.min(sortedAsc.length, Math.max(1, Math.ceil(p * sortedAsc.length)));
  return sortedAsc[rank - 1]!;
}

export function summarize(values: number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, v) => a + v, 0);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  };
}

export interface ScenarioStats {
  samples: number;
  failures: number;
  timeouts: number;
  failureRate: number;
  /** 观测墙钟窗口内的吞吐：采样数 / (首请求发出到末次返回的秒数)。 */
  qps: number;
  client: Percentiles;
  serve: Percentiles;
  physicalSqlAvg: number;
  physicalSqlMax: number;
  prismaCallsAvg: number;
  prismaCallsMax: number;
  rssPeakBytes: number;
}

/**
 * 汇总一个场景的全部样本。wallMs 为该场景采样阶段的总墙钟毫秒（含并发），
 * QPS = 成功+失败采样总数 / 墙钟秒（反映真实并发吞吐，而非串行均值倒数）。
 */
export function summarizeSamples(samples: Sample[], wallMs: number): ScenarioStats {
  const failures = samples.filter((s) => !s.ok).length;
  const timeouts = samples.filter((s) => s.timedOut).length;
  const ok = samples.filter((s) => s.ok);
  const avg = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, v) => a + v, 0) / xs.length);
  return {
    samples: samples.length,
    failures,
    timeouts,
    failureRate: samples.length === 0 ? 0 : failures / samples.length,
    qps: wallMs > 0 ? samples.length / (wallMs / 1000) : 0,
    client: summarize(samples.map((s) => s.clientMs)),
    serve: summarize(ok.map((s) => s.serveMs)),
    physicalSqlAvg: avg(ok.map((s) => s.physicalSql)),
    physicalSqlMax: ok.reduce((m, s) => Math.max(m, s.physicalSql), 0),
    prismaCallsAvg: avg(ok.map((s) => s.prismaCalls)),
    prismaCallsMax: ok.reduce((m, s) => Math.max(m, s.prismaCalls), 0),
    rssPeakBytes: samples.reduce((m, s) => Math.max(m, s.rssBytes), 0),
  };
}

/** 数值保留 3 位小数（报告可读），原始 JSON 不损失精度。 */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
