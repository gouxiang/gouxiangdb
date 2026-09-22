// 产物静态扫描：在所有 dist/*.js 中查找 esbuild 的动态 require 垫片字面量。
//
// 语义（运维与后端共同确认为 fail-closed lint，详见 smoke-dist 顶部说明）：
//   - 断言【字符串字面量】`Dynamic require of`，不断言 `__require` 标识符（会被 minify / esbuild
//     版本改名；字符串在开 minify 后仍保留）。
//   - 命中 = esbuild 为某个被内化的 CJS 依赖注入了 require 垫片，存在无法静态解析的 require
//     调用（不一定在执行路径上）；不命中 = 全产物无动态 require，该类缺陷不可能发生。
//   - 用 glob dist/*.js（不写死入口文件名），将来新增第五个入口自动覆盖。
// 输出命中的【文件名 + 行号 + 该行上下文】，便于一分钟定位（如 ws/lib/websocket.js）。

import fs from "node:fs";
import path from "node:path";

/** esbuild 动态 require 垫片抛出的稳定字符串字面量。 */
export const DYNAMIC_REQUIRE_MARKER = "Dynamic require of";

/**
 * 扫描 distDir 下全部 .js 文件。
 * @param {string} distDir
 * @param {readonly string[]} [allowlist] 显式豁免文件名（命中记 warnings，需调用方打印理由）。
 * @returns {{ failures: Array<{file:string,line:number,context:string}>,
 *            warnings: Array<{file:string,line:number,context:string,allowed:true}> }
 */
export function scanDynamicRequire(distDir, allowlist = []) {
  const files = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith(".js"))
    .sort();
  const allowed = new Set(allowlist);
  /** @type {Array<{file:string,line:number,context:string}>} */
  const failures = [];
  /** @type {Array<{file:string,line:number,context:string,allowed:true}>} */
  const warnings = [];

  for (const file of files) {
    const abs = path.join(distDir, file);
    const lines = fs.readFileSync(abs, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(DYNAMIC_REQUIRE_MARKER)) continue;
      const hit = { file, line: i + 1, context: line.trim().slice(0, 200) };
      if (allowed.has(file)) warnings.push({ ...hit, allowed: true });
      else failures.push(hit);
    }
  }
  return { failures, warnings };
}

/**
 * 把扫描结果格式化成多行可读报告（含文件:行号:上下文）。
 * @param {readonly Array<{file:string,line:number,context:string}>} hits
 * @param {string} distDir
 * @returns {string}
 */
export function formatHits(hits, distDir) {
  return hits
    .map((h) => `  ${path.join(distDir, h.file)}:${h.line}\n      ${h.context}`)
    .join("\n");
}
