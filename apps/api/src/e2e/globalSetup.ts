// M6/S8 e2e 全局前置：构建 **生产 stdio 产物** dist/mcp-stdio.js。
//
// 派工单 §A-4 硬要求：stdio 第二入口必须"真 spawn dist/mcp-stdio.js（GX_MCP_TOKEN=合法 PAT）"，
// 即出口门验的是**随包投递的构建产物**（package.json bin gx-mcp-stdio），不是 tsx 直跑 src/。
// dist 在 .gitignore 内、不落库，故每次 e2e 先构建一次（esbuild 双入口，约数秒）。
// HTTP 形态仍由 in-process 真监听承担（index.ts 的监听代码路径与 dist/index.js 同源，见 startTcpServer）。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSetupContext } from "vitest/node";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** src/e2e -> src -> apps/api */
const API_ROOT = path.resolve(HERE, "../..");
const STDIO_BIN = path.join(API_ROOT, "dist", "mcp-stdio.js");

export default function setup(_ctx: GlobalSetupContext): void {
  // 允许显式跳过（CI 已在更早阶段 build 过时省一次构建）；缺产物则必须构建。
  if (process.env.GX_S8_SKIP_BUILD === "1" && fs.existsSync(STDIO_BIN)) return;
  // stdio:'inherit' 让 esbuild 的产物体积行直接进 e2e 日志（baseline 可引用）。
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: API_ROOT, stdio: "inherit" });
  if (!fs.existsSync(STDIO_BIN)) {
    throw new Error(`[m6-s8] 构建结束但 ${STDIO_BIN} 不存在，stdio 出口门无法成立`);
  }
}
