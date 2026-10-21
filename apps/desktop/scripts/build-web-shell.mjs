#!/usr/bin/env node
// apps/desktop/scripts/build-web-shell.mjs
//
// 桌面壳（Tauri v2，apps/desktop）专用前端构建：产出【门控开启 + 根路径 base】的前端，
// 供 Rust 壳在回环口静态托管（resource_dir/server/public），与现网 / fnOS 的普通构建严格隔离。
//
// 与普通 build 的关系：
//   - 普通 `pnpm --filter @gx/web build`（tsc + vite build）产物落
//     apps/web/dist，不注入门控，供现网 / fnOS 部署，本脚本【不替代】它。
//   - 本脚本是 vite 直调（跳过 web build 里的 tsc）：类型由调用方 / CI 的 typecheck 把关，
//     调用前应已过 web typecheck（pnpm --filter @gx/web typecheck）。
//   - 产物默认落 apps/web/dist-shell，与 apps/web/dist 物理隔离，杜绝两种姿势互相覆盖。
//     独立 outDir 的原因：门控构建（VITE_NODE_LAUNCHER=1）一旦写进 dist 会污染现网产物，
//     现网构建（base 可能为子路径）写进 dist-shell 同样会弄坏桌面壳；两个目录各走各的链路。
//   - 与 stage 的关系：打包时 `stage-node-sidecar.mjs --web-dist apps/web/dist-shell`
//     把本产物拷入 .stage/server/public；不传 --web-dist 时 stage 仍用 apps/web/dist（零变化）。
//
// 强制注入（只覆盖这三个 env，其余 process.env 原样继承，尤其不清 PATH）：
//   VITE_NODE_LAUNCHER=1   开启启动器门控（apps/web/src/node/desktopGate.ts 只认 "1"/"true"）
//   VITE_OFFLINE_Y=1       开启离线 Yjs 累积门控（apps/web/src/features/collab/yOfflineGate.ts，
//                          gx-y:* 本地更新累积/重连自动合并；普通浏览器构建拿不到此 env，恒关）
//   VITE_BASE_PATH=/       根路径 base（apps/web/vite.config.ts 归一为 base="/"）
//
// 用法：
//   node apps/desktop/scripts/build-web-shell.mjs                 # 默认产物 apps/web/dist-shell
//   node apps/desktop/scripts/build-web-shell.mjs --out <dir>     # 覆盖输出目录（相对路径按调用 cwd 解析）
//
// 退出码：构建失败，或产物硬校验不过 => 非 0。

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const webDir = path.join(repoRoot, "apps", "web");

const args = process.argv.slice(2);
let outOpt = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") outOpt = args[++i];
}

// 默认 dist-shell 固定在 apps/web 下；--out 相对路径按调用方 cwd 解析，再转绝对路径交给 vite，
// 避免 vite outDir 相对其 root（apps/web）解析带来的歧义。
const outDir = outOpt ? (path.isAbsolute(outOpt) ? outOpt : path.resolve(process.cwd(), outOpt)) : path.join(webDir, "dist-shell");

const log = (m) => console.log(`[build-web-shell] ${m}`);
function fail(m) {
  console.error(`[build-web-shell] FAIL: ${m}`);
  process.exit(1);
}
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: "inherit", cwd: opts.cwd ?? repoRoot, env: opts.env });
  if (r.error) fail(`${cmd} 启动失败：${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${argv.join(" ")} 退出码 ${r.status ?? "unknown"}`);
}

log(`repoRoot=${repoRoot}`);

// --- 1) vite 门控构建（直调 vite，跳过 tsc；类型由调用方 / CI typecheck 把关）----------
const buildEnv = { ...process.env, VITE_NODE_LAUNCHER: "1", VITE_OFFLINE_Y: "1", VITE_BASE_PATH: "/" };
log("注入构建环境：VITE_NODE_LAUNCHER=1 VITE_OFFLINE_Y=1 VITE_BASE_PATH=/（其余 env 原样继承，含 PATH）");
log(`vite 构建，产物目录：${outDir}`);
run("pnpm", ["exec", "vite", "build", "--outDir", outDir, "--emptyOutDir"], { cwd: webDir, env: buildEnv });

// --- 2) 产物硬校验 -------------------------------------------------------------------
const indexHtml = path.join(outDir, "index.html");
if (!fs.existsSync(indexHtml)) fail(`缺少产物 ${indexHtml}（vite 构建未产出 index.html）`);
const html = fs.readFileSync(indexHtml, "utf8");
// base="/" 生效时，index.html 引用的资产必须是根绝对路径 /assets/...；
// 若漏注入 VITE_BASE_PATH=/（如残留子路径 base），这里会抓到相对/子路径资产并失败。
if (!/(?:src|href)="\/assets\//.test(html)) {
  fail(`base 未生效：${indexHtml} 中未发现以 "/assets/" 开头的资产引用（期望 VITE_BASE_PATH=/ → base="/"）`);
}
log(`硬校验通过：index.html 存在且资产以 "/assets/" 开头（base="/" 已生效）`);
log("门控注入以构建环境为准：本次 spawn 已强制 VITE_NODE_LAUNCHER=1（见上方日志），不对产物做脆弱 grep");
log(`桌面壳专用前端构建完成：${outDir}`);
log("打包接入：node apps/desktop/scripts/stage-node-sidecar.mjs --web-dist " + path.relative(repoRoot, outDir));
