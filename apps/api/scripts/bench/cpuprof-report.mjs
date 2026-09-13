#!/usr/bin/env node
// apps/api/scripts/bench/cpuprof-report.mjs
// S5b-P2 零依赖 CPU profile 归因器：读 node --cpu-prof 产出的 .cpuprofile，
// 聚合「关注函数」的 self time（hitCount × 采样间隔）绝对毫秒与占总采样比。
//
// 只做结构归因（哪段代码在烧 CPU），不产出任何性能阈值结论（计划 §7.1/§3.5）。
// 生产 esbuild 开 keepNames，hydrate.ts 的函数名在 dist/index.js 中保留，可按
// functionName 聚合；同时用 url 后缀（dist/index.js vs native/库）区分来源。
//
// 用法：
//   node cpuprof-report.mjs <a.cpuprofile> [b.cpuprofile ...] \
//     [--label name=path ...] [--top N]
// 退出码：0=解析成功；1=用法/文件错误。

import fs from "node:fs";

// 关注的 hydration 计算/取数函数（计划 §3.5 三函数 + §1 相关）。
const WATCH = new Set([
  "getMergedCached",
  "buildFirstPassMerged",
  "computeFormulas",
  "buildFormulaSource",
  "evalOneFormula",
  "resolveForwardLinks",
  "resolveReverseLinks",
  "buildLinkRefs",
  "resolveLookup",
  "resolveLinkedPeerIds",
  "applyRollup",
  "resolveCount",
  "primaryTitle",
  "hydrateOne",
  "safeEvaluateFormula",
  "evaluateFormula",
]);

function loadProfile(file) {
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(p.nodes)) throw new Error(`${file} 不是合法 CPU profile（无 nodes）`);
  // Node 采样间隔：优先读非标准 meta 字段，缺省回到 V8 默认 1000us。
  const intervalUs =
    typeof p.$x_env_sampleInterval === "number"
      ? p.$x_env_sampleInterval
      : typeof p.samplingInterval === "number"
        ? p.samplingInterval
        : 1000;
  return { p, intervalUs };
}

function summarize(file) {
  const { p, intervalUs } = loadProfile(file);
  let totalHits = 0;
  const selfHits = new Map(); // functionName -> hits
  const urlOf = new Map();
  for (const n of p.nodes) {
    const hits = n.hitCount ?? 0;
    totalHits += hits;
    const name = n.callFrame?.functionName || "(anonymous)";
    if (hits > 0) selfHits.set(name, (selfHits.get(name) ?? 0) + hits);
    if (!urlOf.has(name) && n.callFrame?.url) urlOf.set(name, n.callFrame.url);
  }

  // inclusive（子树）hits：沿 children 累加，回答「整段计算（含其调用的子函数）烧多少 CPU」。
  // self 会把高频子函数（如 parseStored）单列、低估 getMergedCached 这类编排函数；两者都报。
  // V8 同一函数在不同调用栈有多 node：逐 node 算子树命中，再按 functionName 汇总。
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const inclusiveByNode = new Map();
  const subtreeHits = (id, visiting) => {
    if (inclusiveByNode.has(id)) return inclusiveByNode.get(id);
    if (visiting.has(id)) return 0; // 递归环保护（profile 是树状栈，理论无环）
    visiting.add(id);
    const n = byId.get(id);
    let h = n?.hitCount ?? 0;
    for (const c of n?.children ?? []) h += subtreeHits(c, visiting);
    visiting.delete(id);
    inclusiveByNode.set(id, h);
    return h;
  };
  const inclHits = new Map(); // functionName -> 跨所有同名 node 的子树命中之和
  for (const n of p.nodes) {
    const name = n.callFrame?.functionName || "(anonymous)";
    inclHits.set(name, (inclHits.get(name) ?? 0) + subtreeHits(n.id, new Set()));
  }

  // busy 分母：剔除 idle/program/GC/root —— 即真正在跑 JS/native 的采样。
  // C=1 本机大量时间在等 better-sqlite3/Prisma IO（idle），用总采样做分母会稀释计算占比，
  // 故同时给「占总采样」与「占 busy 采样」两个口径，后者回答计算在 CPU 忙时的结构。
  const NON_BUSY = new Set(["(idle)", "(program)", "(root)", "(garbage collector)"]);
  let busyHits = 0;
  for (const [fn, hits] of selfHits) if (!NON_BUSY.has(fn)) busyHits += hits;

  const toMs = (hits) => ((hits * intervalUs) / 1000);
  const mkRow = (fn, hits, denom) => ({
    fn,
    hits,
    selfMs: toMs(hits),
    pct: denom ? (hits / denom) * 100 : 0,
    url: urlOf.get(fn) ?? "",
  });
  const rows = [...selfHits.entries()]
    .map(([fn, hits]) => mkRow(fn, hits, totalHits))
    .sort((a, b) => b.hits - a.hits);
  const inclRows = [...inclHits.entries()]
    .filter(([fn]) => WATCH.has(fn))
    .map(([fn, hits]) => ({
      fn,
      inclMs: toMs(hits),
      pctTotal: totalHits ? (hits / totalHits) * 100 : 0,
      pctBusy: busyHits ? (hits / busyHits) * 100 : 0,
    }))
    .sort((a, b) => b.inclMs - a.inclMs);
  return { file, intervalUs, totalHits, busyHits, totalCpuMs: toMs(totalHits), rows, inclRows };
}

function printReport(label, s, topN) {
  console.log(`\n=== ${label} ===`);
  console.log(`file: ${s.file}`);
  console.log(
    `采样间隔: ${s.intervalUs}us；总采样: ${s.totalHits}（含 idle/IO 等待）；busy(JS/native,剔idle/program/GC): ${s.busyHits}`,
  );
  console.log(`CPU self 合计≈${s.totalCpuMs.toFixed(1)}ms（wall 口径含等待，仅结构归因，非阈值）`);

  console.log("-- 关注函数 self time（仅函数体自身，不含其调用的子函数）--");
  const watchRows = s.rows.filter((r) => WATCH.has(r.fn));
  if (watchRows.length === 0) console.log("  （未采样到任何关注函数；可能场景未触达 hydration 或函数名被压缩）");
  for (const r of watchRows) {
    console.log(
      `  ${r.fn.padEnd(24)} self=${String(r.selfMs.toFixed(1)).padStart(9)}ms  总${String(r.pct.toFixed(2)).padStart(6)}%  busy${(((r.hits / (s.busyHits || 1)) * 100).toFixed(2)).padStart(6)}%  hits=${r.hits}`,
    );
  }
  const watchHits = watchRows.reduce((a, r) => a + r.hits, 0);
  console.log(
    `  ${">> self 合计(可加)".padEnd(26)} self=${(((watchHits * s.intervalUs) / 1000).toFixed(1)).padStart(9)}ms  总${(((watchHits / (s.totalHits || 1)) * 100).toFixed(2)).padStart(6)}%  busy${(((watchHits / (s.busyHits || 1)) * 100).toFixed(2)).padStart(6)}%`,
  );

  console.log("-- 关注函数 inclusive/子树 time（含其调用的全部子函数；跨函数不可相加，会重叠）--");
  for (const r of s.inclRows) {
    console.log(
      `  ${r.fn.padEnd(24)} incl=${String(r.inclMs.toFixed(1)).padStart(9)}ms  总${String(r.pctTotal.toFixed(2)).padStart(6)}%  busy${String(r.pctBusy.toFixed(2)).padStart(6)}%`,
    );
  }

  console.log(`-- CPU self top ${topN}（全函数，定位意外热点）--`);
  for (const r of s.rows.slice(0, topN)) {
    const src = r.url ? r.url.split("/").pop() : "(no-url)";
    console.log(
      `  ${r.fn.slice(0, 34).padEnd(36)} self=${String(r.selfMs.toFixed(1)).padStart(9)}ms  ${String(r.pct.toFixed(2)).padStart(6)}%  [${src}]`,
    );
  }
}

function main() {
  const argv = process.argv.slice(2);
  let topN = 20;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--top") {
      topN = Number(argv[i + 1] ?? "20");
      i += 1;
    } else if (!argv[i].startsWith("--")) {
      files.push(argv[i]);
    }
  }
  if (files.length === 0) {
    console.error("用法：node cpuprof-report.mjs <a.cpuprofile> [...] [--top N]");
    process.exit(1);
  }
  for (const f of files) {
    if (!fs.existsSync(f)) {
      console.error(`profile 不存在：${f}`);
      process.exit(1);
    }
    printReport(f.split("/").pop(), summarize(f), topN);
  }
}

main();
