#!/usr/bin/env node
// scripts/acceptance/check-nav-paths.mjs
// 门② G2 补强①：坐实 #175 nav-reconcile 部署链接入的真实必要性与幂等性。
//
// 前置：prisma migrate deploy 已把库从 v0.1.0(11) 升到 23 迁移、但【尚未】跑 nav-reconcile。
// 本脚本按顺序做并留证：
//   1) 故障态（裸 SQL，只读）：非根实体节点（table/view/doc/canvas）path='' AND depth=0；
//      根节点（base/kb）path='/<id>/' AND depth=1。
//   2) 二次 migrate deploy 幂等：无 pending、exit 0。
//   3) reconcile 只读（--json）此时必报 A6（path/depth 不一致）且 exit 1（证明迁移不递归拼 path）。
//   4) reconcile --apply：exit 0，记录 fix.nodes.pathsRebuilt=N（>0）。
//   5) 修复态（裸 SQL，只读）：每个活节点 path 都能由 parentId 链独立重算复现；
//      table/view depth=2，kb 直属 doc/canvas depth=2，嵌套 doc depth=3。
//   6) reconcile 只读再跑：A/B/C=0、exit 0；--apply 再跑："no changes"。
//
// reconcile 一律跑【生产发布物】dist/nav-reconcile.js（plain node，脱离 tsx），
// 与部署链路（#175）实际执行位一致；不跑 tsx 源码。
//
// 退出码：0 全绿；1 任一断言失败；64 参数/环境错。

import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { openDb } from "./lib/db.mjs";
import { parseJsonHead } from "./lib/jsonHead.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function fail(code, msg) {
  console.error(`[check-nav-paths] ${msg}`);
  process.exit(code);
}

const dbFile = arg("--db");
const outDir = arg("--out");
const apiDir = arg("--api-dir");
const reconcileDist = arg("--dist") ?? path.join(apiDir ?? "", "dist", "nav-reconcile.js");
if (!dbFile || !outDir || !apiDir) {
  fail(64, "用法: check-nav-paths.mjs --db <abs.db> --out <dir> --api-dir <apps/api> [--dist <dist/nav-reconcile.js>]");
}
// 必须跑真发布物：缺件即环境/参数错（exit 64），不退化为 tsx 源码。
if (!fs.existsSync(reconcileDist)) {
  fail(64, `缺少生产发布物 ${reconcileDist}（先执行 apps/api/scripts/build.mjs）`);
}

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd: opts.cwd ?? apiDir, env: { ...process.env, DATABASE_URL: `file:${dbFile}`, ...opts.env } });
    let out = ""; let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
  });
}
const nodeBin = process.execPath;
const prismaBin = path.join(apiDir, "node_modules/prisma/build/index.js");
// 生产发布物（esbuild 扁平 ESM），plain node 直接运行；DATABASE_URL 走 env（绝对 file: 路径）。
const reconcileArgs = (extra) => [reconcileDist, ...extra];

/** 独立按 parentId 链重算每个活节点期望 path（不引用生产 tree.ts，防循环论证）。 */
function expectedPaths(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map();
  function calc(id, seen = new Set()) {
    if (memo.has(id)) return memo.get(id);
    const n = byId.get(id);
    if (!n) return null;
    if (seen.has(id)) return null; // 环（不应有）
    seen.add(id);
    let p;
    if (!n.parentId || !byId.has(n.parentId)) p = `/${n.id}/`;
    else {
      const pp = calc(n.parentId, seen);
      p = pp === null ? null : `${pp}${n.id}/`;
    }
    memo.set(id, p);
    return p;
  }
  const out = new Map();
  for (const n of nodes) out.set(n.id, calc(n.id));
  return out;
}

function faultSnapshot() {
  const db = openDb(dbFile, { readonly: true });
  const roots = db.prepare(
    "SELECT id, kind FROM nav_nodes WHERE deletedAt IS NULL AND kind IN ('base','kb')",
  ).all();
  const nonRoots = db.prepare(
    "SELECT id, kind, resourceType, path, depth FROM nav_nodes " +
      "WHERE deletedAt IS NULL AND kind IN ('table','view','doc','canvas')",
  ).all();
  const badRoot = roots.filter((r) => {
    const row = db.prepare("SELECT path, depth FROM nav_nodes WHERE id=?").get(r.id);
    return row.path !== `/${r.id}/` || row.depth !== 1;
  });
  const stuck = nonRoots.filter((n) => n.path === "" && n.depth === 0);
  const notStuck = nonRoots.filter((n) => !(n.path === "" && n.depth === 0));
  db.close();
  return {
    rootCount: roots.length, nonRootCount: nonRoots.length,
    badRootCount: badRoot.length, stuckCount: stuck.length, prematureCount: notStuck.length,
    pass: roots.length > 0 && nonRoots.length > 0 && badRoot.length === 0
      && stuck.length === nonRoots.length,
  };
}

function postSnapshot() {
  const db = openDb(dbFile, { readonly: true });
  const nodes = db.prepare(
    "SELECT id, parentId, kind, resourceType, path, depth FROM nav_nodes WHERE deletedAt IS NULL",
  ).all();
  const expect = expectedPaths(nodes);
  const mismatches = [];
  for (const n of nodes) {
    const want = expect.get(n.id);
    const wantDepth = want === null ? -1 : want.split("/").filter(Boolean).length;
    if (want !== n.path || wantDepth !== n.depth) {
      mismatches.push({ id: n.id, kind: n.kind, gotPath: n.path, gotDepth: n.depth, wantPath: want, wantDepth });
    }
  }
  const depthHist = {};
  for (const n of nodes) depthHist[n.depth] = (depthHist[n.depth] ?? 0) + 1;
  const tables = nodes.filter((n) => n.kind === "table");
  const views = nodes.filter((n) => n.kind === "view");
  const rootDocs = nodes.filter((n) => (n.kind === "doc" || n.kind === "canvas") && n.depth === 2);
  const nestedDocs = nodes.filter((n) => n.kind === "doc" && n.depth === 3);
  const emptyPath = nodes.filter((n) => n.path === "");
  db.close();
  return {
    nodeCount: nodes.length,
    depthHist,
    tableDepth2: tables.length > 0 && tables.every((n) => n.depth === 2),
    viewDepth3: views.every((n) => n.depth === 3),
    rootLevelDocCount: rootDocs.length,
    nestedDocCount: nestedDocs.length,
    hasNestedDepth3: nestedDocs.length > 0,
    emptyPathCount: emptyPath.length,
    pathMismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 10),
    pass: mismatches.length === 0 && emptyPath.length === 0
      && tables.length > 0 && tables.every((n) => n.depth === 2)
      && views.every((n) => n.depth === 3)
      && rootDocs.length > 0 && nestedDocs.length > 0,
  };
}

async function main() {
  const report = { steps: {} };
  let failure = "";

  // 1) 故障态
  const before = faultSnapshot();
  report.steps.faultState = before;
  console.log(`[nav] 故障态：根=${before.rootCount}（坏=${before.badRootCount}），`
    + `非根=${before.nonRootCount}，path=''/'depth0 卡住=${before.stuckCount}，提前物化=${before.prematureCount}`);
  if (!before.pass) failure = "故障态不符：预期所有非根节点 path='' depth=0、根节点已物化";

  // 2) 二次 migrate deploy 幂等
  if (!failure) {
    const mig = await run(nodeBin, [prismaBin, "migrate", "deploy"]);
    const already = /already in sync|No pending migrations|already applied/i.test(mig.out + mig.err);
    report.steps.secondMigrate = { exit: mig.code, alreadyInSync: already, tail: (mig.out + mig.err).trim().slice(-300) };
    console.log(`[nav] 二次 migrate deploy exit=${mig.code} alreadyInSync=${already}`);
    if (mig.code !== 0 || !already) failure = "二次 migrate deploy 非幂等";
  }

  // 3) 只读 reconcile 在故障态必报 A6 exit 1
  if (!failure) {
    const ro = await run(nodeBin, reconcileArgs(["--json"]));
    let parsed = null;
    parsed = parseJsonHead(ro.out);
    const a6 = parsed?.A?.filter((d) => d.code === "A6").length ?? 0;
    report.steps.readOnlyBefore = { exit: ro.code, a6Count: a6, summary: parsed?.summary ?? null };
    console.log(`[nav] 修复前只读 exit=${ro.code} A6=${a6} summary=${JSON.stringify(parsed?.summary ?? null)}`);
    if (ro.code !== 1 || a6 === 0) failure = "故障态只读 reconcile 未以 exit1/A6>0 报告 path 损坏";
  }

  // 4) --apply
  let applyJson = null;
  if (!failure) {
    const applied = await run(nodeBin, reconcileArgs(["--apply", "--json"]));
    applyJson = parseJsonHead(applied.out);
    const rebuilt = applyJson?.fix?.nodes?.pathsRebuilt ?? 0;
    report.steps.apply = { exit: applied.code, fix: applyJson?.fix ?? null, afterSummary: applyJson?.after?.summary ?? null };
    console.log(`[nav] --apply exit=${applied.code} pathsRebuilt=${rebuilt}`);
    if (applied.code !== 0 || rebuilt === 0) failure = "reconcile --apply 失败或 pathsRebuilt=0";
  }

  // 5) 修复态裸 SQL
  if (!failure) {
    const after = postSnapshot();
    report.steps.postState = after;
    console.log(`[nav] 修复态：节点=${after.nodeCount} depthHist=${JSON.stringify(after.depthHist)} `
      + `直属doc/canvas=${after.rootLevelDocCount} 嵌套doc(depth3)=${after.nestedDocCount} path不符=${after.pathMismatchCount}`);
    if (!after.pass) failure = "修复后仍有 path/depth 与 parentId 链不一致或缺 depth2/3 物化";
  }

  // 6) 二次只读干净 + 二次 --apply no changes
  if (!failure) {
    const ro2 = await run(nodeBin, reconcileArgs(["--json"]));
    const p2 = parseJsonHead(ro2.out);
    const clean = ro2.code === 0 && (p2?.summary?.A ?? 1) === 0 && (p2?.summary?.B ?? 1) === 0 && (p2?.summary?.C ?? 1) === 0;
    const ap2 = await run(nodeBin, reconcileArgs(["--apply"]));
    const noChanges = ap2.code === 0 && /no changes/.test(ap2.out);
    report.steps.idempotent = { readOnlyExit: ro2.code, readOnlyClean: clean, applyExit: ap2.code, applyNoChanges: noChanges };
    console.log(`[nav] 二次只读 exit=${ro2.code} clean=${clean}；二次 --apply exit=${ap2.code} noChanges=${noChanges}`);
    if (!clean || !noChanges) failure = "二次 reconcile 非幂等";
  }

  report.pass = !failure;
  report.failure = failure || null;
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "nav-paths-result.json");
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`[nav] ${report.pass ? "PASS" : "FAIL: " + failure} -> ${outFile}`);
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error("[check-nav-paths] 失败：", e);
  process.exit(1);
});
