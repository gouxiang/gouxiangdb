#!/usr/bin/env node
// dist 产物冒烟门：真跑 dist/index.js + 静态扫描全部 dist/*.js。
//
// 为什么需要这道门：本机 `pnpm build` 只打包、不执行产物。像 ws（CJS）被 esbuild 内化进 ESM
// 单文件后运行时 require("events") 抛 "Dynamic require ... is not supported" 这种缺陷，任何静态
// 门都看不见，只有真机 spawn 一次才能复现（本次是靠 systemd 连炸 5 次才偶然抓到，不该靠运气）。
//
// 两道检查：
//   1) 真跑（index.js 唯一判据）：临时库 + 临时端口 + 临时数据目录启动，轮询 /readyz 且校验
//      status==="ready" 与 checks 各项为 true（防"进程活但探针半死"）。
//   2) 静态扫描（其余不能真跑的产物唯一手段）：dist/*.js 全部不允许出现 esbuild 动态 require 垫片
//      字面量。语义=可能假阳性、绝不假阴性；命中即硬失败（详见 smoke/scan-dynamic-require.mjs）。
//
// 退出码：0 通过 / 1 冒烟失败（探针不 ready / 静态扫描命中）/ 2 进程起不来（崩溃）。
//
// 纪律：不碰真库（仅临时 DATABASE_URL）、不绑 3001（临时端口）、临时 GX_DATA_DIR、离线（不
// 开 GX_M5_SEARCH）、30s 预算；失败回吐子进程全部 stdout/stderr；无论成败 kill 子进程 + 删临时目录。
//
// 用法：node scripts/smoke-dist.mjs（构建产物须已存在；`smoke:dist` 会先 build 再跑本脚本）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanDynamicRequire, formatHits } from "./smoke/scan-dynamic-require.mjs";
import {
  pickFreePort, migrateTempDb, resolvePrismaBin, runIndexUntilReady,
} from "./smoke/run-index.mjs";

const __filename = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(__filename);
const apiRoot = path.resolve(scriptsDir, "..");
const distDir = path.join(apiRoot, "dist");
const distEntry = path.join(distDir, "index.js");
const schemaPath = path.join(apiRoot, "prisma", "schema.prisma");

/** @param {string} msg */
function log(msg) {
  process.stdout.write(`[smoke-dist] ${msg}\n`);
}

/** @param {{ stdout: string, stderr: string }} run */
function dumpChild(run) {
  if (run.stdout.trim()) process.stdout.write("--- child stdout ---\n" + run.stdout);
  if (run.stderr.trim()) process.stderr.write("--- child stderr ---\n" + run.stderr);
}

/** @returns {Promise<number>} */
async function main() {
  if (!fs.existsSync(distEntry)) {
    log(`缺少 ${distEntry}，请先运行 pnpm build`);
    return 1;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gx-smoke-"));
  let port = 0;
  /** @type {Awaited<ReturnType<typeof runIndexUntilReady>> | null} */
  let run = null;
  try {
    port = await pickFreePort();
    const smokeDb = path.join(tmp, "smoke.db");
    /** @type {NodeJS.ProcessEnv} */
    const env = {
      ...process.env,
      NODE_ENV: "test", // 免限流（含 /readyz），但仍是真进程真库真探针
      DATABASE_URL: `file:${smokeDb}`,
      GX_DATA_DIR: tmp,
      PORT: String(port),
    };
    // 离线/最小姿态：不开统一检索、不走 unix socket、不指定 audit（落到 GX_DATA_DIR/.audit）。
    delete env.GX_M5_SEARCH;
    delete env.GX_SOCKET_PATH;
    delete env.GX_AUDIT_DIR;
    env.GX_RATE_LIMIT = "off";

    log(`临时目录 ${tmp}；对临时库 migrate deploy …`);
    await migrateTempDb(resolvePrismaBin(), schemaPath, env);

    log(`启动 dist/index.js（临时端口 ${port}），等待 /readyz（≤30s）…`);
    run = await runIndexUntilReady({ distEntry, port, env });

    if (!run.ok) {
      const exitCode = run.reason === "crashed" ? 2 : 1;
      log(`FAIL：${run.detail}（exit=${exitCode}）`);
      dumpChild(run);
      return exitCode;
    }
    log("index.js 真跑通过：/readyz status=ready，checks 全 true");

    // 静态扫描全部产物（index 也扫，但已有真跑兜底；其余三份这是唯一手段）。
    const { failures, warnings } = scanDynamicRequire(distDir);
    for (const w of warnings) log(`豁免（需注释理由）：${w.file}:${w.line}`);
    if (failures.length > 0) {
      log("FAIL：产物含 esbuild 动态 require 垫片（内化 CJS 依赖，真机可能启动崩）：");
      process.stdout.write(formatHits(failures, distDir) + "\n");
      return 1;
    }
    log("静态扫描通过：dist/*.js 全部无动态 require 垫片");
    return 0;
  } catch (err) {
    log(`冒烟执行出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (run) dumpChild(run);
    return 1;
  } finally {
    // 无论成败：kill 子进程 + 删临时目录（避免孤儿进程/临时库堆积）。
    run?.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write(`[smoke-dist] 致命错误：${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
