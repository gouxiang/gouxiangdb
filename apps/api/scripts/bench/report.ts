// apps/api/scripts/bench/report.ts
// M1/S9 压测报告渲染：汇总各场景 P50/P95/P99/QPS/失败率/双计数/RSS，落 JSON（机器可读）
// 与 Markdown（人工评审）。门判定只认服务端 serve-ms（不含网络），P95 阈值可配。

import fs from "node:fs";
import type { ScenarioResult } from "./load.js";
import { round3 } from "./stats.js";

export interface GateConfig {
  /**
   * 读场景服务端 P95 阈值毫秒（M1/S10 证伪目标：物理索引命中 <1500，见 ADR-0008）。
   * 传 0 表示【关闭性能门】，仅裁决正确性（失败率/超时/drift）——用于 S9 harness 自检，
   * P95 数据仍完整落 JSON/MD，不因真实性能信号把脚手架本身判失败。
   */
  readP95Ms: number;
  /** 允许的失败率上限（0..1）。 */
  maxFailureRate: number;
}

export interface RunMeta {
  generatedAt: string;
  dbFile: string;
  rows: number;
  shape: string;
  seed: number;
  scale: string; // 10k/100k/500k/1m/custom
  flags: { read: string; keyset: string; prefetch: string };
  warmup: number;
  samples: number;
  concurrency: number;
  limit: number;
  host: string; // 机型号/核内存（调用方传入，本地默认标注 local）
  node: string;
  /** 单请求超时毫秒。 */
  timeoutMs?: number;
  /** shadow 档双跑差异汇总（仅 shadow 模式有值）。 */
  shadowDrift?: { count: number; samples: string[] };
  /** 写后离线对拍 sidecar drift（missing/extra/mismatch/orphans）。 */
  sidecarDrift?: { drift: number; missing: number; extra: number; mismatch: number; orphans: number };
}

export interface GateVerdict {
  pass: boolean;
  readP95Ms: number;
  maxFailureRate: number;
  breaches: string[];
}

/**
 * 门判定：所有【读】场景 serve P95 < 阈值且失败率达标；写场景只看失败率（单独列）。
 * sidecarDrift 非 0（写后对拍）直接判失败。
 */
export function judge(results: ScenarioResult[], gate: GateConfig, sidecarDrift?: RunMeta["sidecarDrift"]): GateVerdict {
  const breaches: string[] = [];
  for (const r of results) {
    const isRead = r.kind !== "write" && r.kind !== "mixed";
    if (r.stats.failureRate > gate.maxFailureRate) {
      breaches.push(`${r.scene}: 失败率 ${(r.stats.failureRate * 100).toFixed(2)}% > ${gate.maxFailureRate * 100}%`);
    }
    if (r.stats.timeouts > 0) {
      breaches.push(`${r.scene}: 超时 ${r.stats.timeouts} 次`);
    }
    // readP95Ms=0：性能门关闭（S9 自检只验正确性），P95 仍在报告中呈现。
    if (isRead && gate.readP95Ms > 0 && r.stats.serve.p95 >= gate.readP95Ms) {
      breaches.push(`${r.scene}: 读 P95 ${round3(r.stats.serve.p95)}ms ≥ ${gate.readP95Ms}ms（${r.desc}）`);
    }
  }
  if (sidecarDrift && sidecarDrift.drift !== 0) {
    breaches.push(
      `sidecar drift=${sidecarDrift.drift}（missing=${sidecarDrift.missing} extra=${sidecarDrift.extra} ` +
      `mismatch=${sidecarDrift.mismatch} orphans=${sidecarDrift.orphans}），写后同事务维护失配`,
    );
  }
  return {
    pass: breaches.length === 0,
    readP95Ms: gate.readP95Ms,
    maxFailureRate: gate.maxFailureRate,
    breaches,
  };
}

function fmtBytes(n: number): string {
  if (n <= 0) return "-";
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 生成 Markdown 报告。 */
export function renderMarkdown(meta: RunMeta, results: ScenarioResult[], verdict: GateVerdict): string {
  const lines: string[] = [];
  lines.push(`# M1 压测报告 — ${meta.scale} 行（${meta.shape}）`);
  lines.push("");
  lines.push(`- 生成时间：${meta.generatedAt}`);
  lines.push(`- 数据：${meta.rows.toLocaleString()} 行，seed=${meta.seed}，库=${meta.dbFile}`);
  lines.push(`- 机型：${meta.host}；Node ${meta.node}`);
  lines.push(`- flag：read=${meta.flags.read} keyset=${meta.flags.keyset} prefetch=${meta.flags.prefetch}`);
  lines.push(`- 采样：预热丢弃 ${meta.warmup}，每场景 ${meta.samples} 次，并发 ${meta.concurrency}，limit=${meta.limit}`);
  lines.push(verdict.readP95Ms > 0
    ? `- 门：读 serve-P95 < ${verdict.readP95Ms}ms，失败率 ≤ ${verdict.maxFailureRate * 100}%`
    : `- 门：性能门已关闭（--read-p95-ms 0，仅裁决正确性）；失败率 ≤ ${verdict.maxFailureRate * 100}%。各场景 P95 仍见下表，供 S10 证伪使用。`);
  lines.push(`- 裁决：**${verdict.pass ? "PASS" : "FAIL"}**`);
  if (meta.timeoutMs) lines.push(`- 单请求超时阈值：${meta.timeoutMs}ms`);
  if (meta.sidecarDrift) {
    lines.push(`- 写后 sidecar drift：${meta.sidecarDrift.drift}（missing=${meta.sidecarDrift.missing} extra=${meta.sidecarDrift.extra} mismatch=${meta.sidecarDrift.mismatch} orphans=${meta.sidecarDrift.orphans}）`);
  }
  if (meta.shadowDrift) {
    lines.push(`- shadow 双跑差异：${meta.shadowDrift.count} 行`);
    meta.shadowDrift.samples.slice(0, 10).forEach((s) => lines.push(`  - ${s}`));
  }
  lines.push("");
  lines.push("计时口径：serve-ms=服务端中间件（不含网络），client-ms=客户端往返。physical-sql=下推读物理 SQL 条数，prisma-calls=ORM 模型操作往返数（Prisma SQLite 不支持 query 事件，无法逐条 SQL 计数，见 benchMetrics.ts 头注）。");
  lines.push("");
  lines.push("| 场景 | 类型 | 档位 | 样本 | 失败% | 超时 | QPS | serve P50 | serve P95 | serve P99 | client P95 | physSql 均/峰 | prisma 均/峰 | RSS峰 |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of results) {
    const s = r.stats;
    lines.push([
      `\`${r.scene}\``,
      r.kind,
      r.mode,
      s.samples,
      (s.failureRate * 100).toFixed(2),
      s.timeouts,
      round3(s.qps),
      round3(s.serve.p50),
      round3(s.serve.p95),
      round3(s.serve.p99),
      round3(s.client.p95),
      `${round3(s.physicalSqlAvg)}/${s.physicalSqlMax}`,
      `${round3(s.prismaCallsAvg)}/${s.prismaCallsMax}`,
      fmtBytes(s.rssPeakBytes),
    ].join(" | "));
  }
  lines.push("");
  if (verdict.breaches.length > 0) {
    lines.push("## 未达标项");
    for (const b of verdict.breaches) lines.push(`- ${b}`);
    lines.push("");
  }
  lines.push("## 场景说明");
  for (const r of results) lines.push(`- \`${r.scene}\`：${r.desc}`);
  lines.push("");
  return lines.join("\n");
}

export interface WrittenReport {
  jsonPath: string;
  mdPath: string;
}

/** 落 JSON + Markdown。 */
export function writeReports(
  outDir: string,
  tag: string,
  meta: RunMeta,
  results: ScenarioResult[],
  verdict: GateVerdict,
): WrittenReport {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = `${outDir}/${tag}.json`;
  const mdPath = `${outDir}/${tag}.md`;
  fs.writeFileSync(jsonPath, JSON.stringify({ meta, verdict, results }, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(meta, results, verdict));
  return { jsonPath, mdPath };
}
