#!/usr/bin/env node
// scripts/acceptance/build-manifest.mjs
// 汇总 steps.tsv + before/manifest.json + after 各门 result 生成 run-manifest.json。
// 只汇总本地产物、不做 PASS/FAIL 判定（判定在 build-report.mjs）；纯读 JSON，不连服务/库。
//
// 用法: build-manifest.mjs --run-dir <dir> --node-version <v> --old-commit <c> --new-commit <c>
//         --old-mig N --new-mig N

import fs from "node:fs";
import path from "node:path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function fail(msg) {
  console.error(`[build-manifest] ${msg}`);
  process.exit(64);
}

const runDir = arg("--run-dir");
const nodeVersion = arg("--node-version");
const oldCommit = arg("--old-commit");
const newCommit = arg("--new-commit");
const oldMig = Number(arg("--old-mig"));
const newMig = Number(arg("--new-mig"));
if (!runDir || !nodeVersion || !oldCommit || !newCommit) fail("缺必需参数");

const beforeDir = path.join(runDir, "before");
const afterDir = path.join(runDir, "after");
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

const steps = fs.readFileSync(path.join(runDir, "steps.tsv"), "utf8").trim().split("\n")
  .filter(Boolean)
  .map((line) => {
    const [name, exit, durMs] = line.split("\t");
    return { name, exit: Number(exit), durMs: Number(durMs) };
  });
const get = (f) => readJson(path.join(afterDir, f));
const diff = get("diff-result.json");
const golden = get("golden-result.json");
const nav = get("nav-paths-result.json");
const search = get("search-result.json");
const body = get("body-limits-result.json");
const bootstrap = get("bootstrap-result.json");
const seed = readJson(path.join(beforeDir, "manifest.json"));
const shareLog = fs.existsSync(path.join(afterDir, "share-links.log"))
  ? fs.readFileSync(path.join(afterDir, "share-links.log"), "utf8") : "";

const manifest = {
  schema: "gx-upgrade-drill-run@2",
  runDir,
  nodeVersion,
  commits: { v010: oldCommit, head: newCommit },
  migrations: { old: oldMig, new: newMig },
  seedCounts: seed?.counts ?? null,
  totalDurMs: steps.reduce((n, s) => n + s.durMs, 0),
  steps,
  verdicts: {
    diffZeroDamage: diff?.verdict === "PASS",
    diffDamageCount: diff?.damageCount ?? null,
    timestampChanges: Object.values(diff?.stats ?? {}).reduce((n, t) => n + ((t && t.tsChanges) || 0), 0),
    navPaths: nav?.pass ?? false,
    navPathsRebuilt: nav?.steps?.apply?.fix?.nodes?.pathsRebuilt ?? null,
    bootstrap: bootstrap?.verdict === "PASS",
    bootstrapApplied: bootstrap?.ledger?.applied ?? null,
    shareLinks: /SHARE_VERDICT=PASS/.test(shareLog),
    golden: golden?.summary ? {
      golden: `${golden.summary.goldenPass}/${golden.summary.goldenTotal}`,
      lcg: `${golden.summary.lcgPass}/${golden.summary.lcgTotal}`,
      reconcile: golden.summary.reconcilePass,
      deptSubtree: golden.summary.deptSubtreePass,
      cutoff: golden.summary.cutoffPass,
      disabled: golden.summary.disabledPass,
    } : null,
    searchFtsOnly: search?.pass ?? false,
    bodyLimits: body?.pass ?? false,
  },
};
fs.writeFileSync(path.join(runDir, "run-manifest.json"), JSON.stringify(manifest, null, 2));
console.log("[build-manifest] run-manifest.json 已写出");
