// apps/api/scripts/bench/m5-report.ts
// M5/S13 报告渲染（纯格式化）：GateReport -> Markdown 片段（可直接并入 docs/baseline）。
// 每个 (档, dim) 下按 --scope-caps 逐档出一行，便于直接读"收紧 scope"杠杆。

import { formatSpecSummary } from "./m5-spec.js";
import { miB } from "./m5-bench-lib.js";
import type { GateReport } from "./m5-types.js";

export function renderMarkdown(r: GateReport): string {
  const rows: string[] = [];
  for (const c of r.combos) {
    if (c.skipped) {
      rows.push(`| ${c.label} | ${c.chunksRequested} | ${c.dim} | ${r.config.benchMode} | ${r.config.k} | — | — | SKIP: ${c.skipped.reason} — ${c.skipped.detail} |`);
      continue;
    }
    for (const s of c.scopes ?? []) {
      const p95 = s.rounds.p95Ms;
      rows.push(
        `| ${c.label} | ${c.chunks} | ${c.dim} | ${c.mode} | ${c.k} | ${s.cap}${s.scopeTruncated ? "(截)" : ""} | ${s.rounds.rounds} | p50=${s.rounds.p50Ms.toFixed(1)} / **p95=${p95.toFixed(1)}** / max=${s.rounds.maxMs.toFixed(1)} ms | RSS ${miB(s.rss.peakBytes)}MiB; db ${miB(c.dbBytes!)}MiB; scope ${s.scopeNodes}; hits fts=${s.hits.fts} vec=${s.hits.vec}; EXPLAIN ${s.explain.ok ? "OK" : "FAIL"} |`,
      );
    }
  }
  return [
    `# M5/S13 规模门压测报告（参考画像）`,
    ``,
    `- 生成时间：${r.generatedAt}`,
    `- 口径：${r.mode}`,
    `- 配置：sizes=[${r.config.sizes}] dims=[${r.config.dims}] rounds=${r.config.rounds} `
      + `mode=${r.config.benchMode} k=${r.config.k} scopeCaps=[${r.config.scopeCaps}] seed=${r.config.seed} targetP95=${r.config.targetP95Ms}ms`,
    ``,
    `## 机器画像`,
    formatSpecSummary(r.machine),
    ``,
    `## 结果`,
    `| 档 | chunks | dim | mode | k | cap | 轮 | 时延 | 资源/命中/EXPLAIN |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...rows,
    ``,
    `## 可流畅 chunk 上限（线性外推，参考画像）`,
    `- 上限 ≈ ${r.smoothLimit.limit ?? "未达阈值"} chunk（主维 ${r.config.dims[0]}, 主 cap ${Math.max(...r.config.scopeCaps)}）`,
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
