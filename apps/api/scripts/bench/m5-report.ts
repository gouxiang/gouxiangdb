// apps/api/scripts/bench/m5-report.ts
// M5/S13 报告渲染（纯格式化）：GateReport -> Markdown 片段（可直接并入 docs/baseline）。

import { formatSpecSummary } from "./m5-spec.js";
import type { GateReport } from "./m5-gate.js";

export function miB(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

export function renderMarkdown(r: GateReport): string {
  const rows = r.combos.map((c) => {
    if (c.skipped) {
      return `| ${c.label} | ${c.chunksRequested} | ${c.dim} | — | SKIP: ${c.skipped.reason} | ${c.skipped.detail} |`;
    }
    const rr = c.rounds!;
    const warn = c.warnings && c.warnings.length > 0 ? ` (warn×${c.warnings.length})` : "";
    return `| ${c.label} | ${c.chunks} | ${c.dim} | ${rr.rounds} | p50=${rr.p50Ms.toFixed(1)} / **p95=${rr.p95Ms.toFixed(1)}** / max=${rr.maxMs.toFixed(1)} ms | RSS peak ${miB(c.rss!.peakBytes)}MiB; db ${miB(c.dbBytes!)}MiB; scope ${c.scopeNodes}${c.scopeTruncated ? "(截断)" : ""}; hits fts=${c.hits!.fts} vec=${c.hits!.vec}; EXPLAIN ${c.explain!.ok ? "OK" : "FAIL"}${warn} |`;
  });
  return [
    `# M5/S13 规模门真机压测报告（参考画像）`,
    ``,
    `- 生成时间：${r.generatedAt}`,
    `- 口径：${r.mode}`,
    `- 配置：sizes=[${r.config.sizes}] dims=[${r.config.dims}] rounds=${r.config.rounds} seed=${r.config.seed} scopeCap=${r.config.scopeCap} targetP95=${r.config.targetP95Ms}ms`,
    ``,
    `## 机器画像`,
    formatSpecSummary(r.machine),
    ``,
    `## 结果`,
    `| 档 | chunks | dim | 轮 | 时延 | 资源/命中/EXPLAIN |`,
    `|---|---|---|---|---|---|`,
    ...rows,
    ``,
    `## 可流畅 chunk 上限（线性外推，参考画像）`,
    `- 上限 ≈ ${r.smoothLimit.limit ?? "未达阈值"} chunk（主维 ${r.config.dims[0]}）`,
    `- ${r.smoothLimit.note}`,
    ``,
    `## Tier-S（1万–10万，初期 NAS 真实区间）`,
    `- ${r.tierS.note}`,
    ``,
    `## 边界与说明`,
    ...r.notes.map((n) => `- ${n}`),
    ``,
  ].join("\n");
}
