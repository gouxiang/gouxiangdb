#!/usr/bin/env node
// scripts/acceptance/diff-snapshot.mjs
// 升级零损坏判定 CLI：载入 before/after snapshot.json，调 diff/checks.mjs 七类判定，
// 落 diff-result.json 并按结果退出。
//   0 = 全部 P0 检查 0 损坏；1 = 存在损坏（打印定位）；64 = 参数/快照缺件。
// 七类判定与补强③时间戳检查实现见 diff/checks.mjs；归一化纯函数见 lib/snapnorm.mjs。

import fs from "node:fs";
import path from "node:path";
import { runChecks } from "./diff/checks.mjs";

function fail(code, msg) {
  console.error(`[diff-snapshot] ${msg}`);
  process.exit(code);
}

const beforeDir = process.argv[2];
const afterDir = process.argv[3];
if (!beforeDir || !afterDir) fail(64, "用法: diff-snapshot.mjs <before-dir> <after-dir>");
const beforePath = path.join(beforeDir, "snapshot.json");
const afterPath = path.join(afterDir, "snapshot.json");
if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) fail(64, "缺少 snapshot.json（before 或 after）");

const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
const after = JSON.parse(fs.readFileSync(afterPath, "utf8"));

const { damages, warns, stats } = runChecks(before, after, beforeDir, afterDir);

const result = {
  verdict: damages.length === 0 ? "PASS" : "FAIL",
  damageCount: damages.length,
  warnCount: warns.length,
  stats,
  damages,
  warns,
};
fs.writeFileSync(path.join(afterDir, "diff-result.json"), JSON.stringify(result, null, 2));

console.log("\n========== 零损坏 diff ==========");
for (const t of Object.keys(stats)) {
  if (typeof stats[t] === "object" && (stats[t].tsChanges !== undefined || stats[t].fieldDiffs !== undefined)) {
    console.log(`  ${t}: count=${stats[t].count} 时间戳改动=${stats[t].tsChanges} 行内容diff=${stats[t].fieldDiffs}`);
  }
}
console.log(`  画布板核对=${stats.canvasBoardsChecked}，附件引用核对=${stats.attachmentRefsChecked}`);
if (warns.length) { console.log("警告："); for (const w of warns) console.log(`  - ${w}`); }
if (damages.length) {
  console.log(`\n发现 ${damages.length} 处损坏（前 30）：`);
  for (const d of damages.slice(0, 30)) console.log(`  [${d.category}] ${d.locator}\n      期望: ${d.expected}\n      实际: ${d.actual}`);
  console.log(`\nDIFF_VERDICT=FAIL`);
  process.exit(1);
}
console.log("\n全部 P0 对象 0 损坏。");
console.log("DIFF_VERDICT=PASS");
