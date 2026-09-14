#!/usr/bin/env node
// deploy/fnos/build-fpk.mjs — 组装飞牛 fnOS 原生应用 server/ 并调用 fnpack build。
//
// 产出：gouxiangdb-<version>-<arch>.fpk（在本脚本目录或 fnpack 默认输出位置）。
//
// 用法：
//   node deploy/fnos/build-fpk.mjs --arch x86     # x86_64 设备
//   node deploy/fnos/build-fpk.mjs --arch arm     # arm64 设备
//
// 架构铁律：
//   fpk 内含 better-sqlite3(.node) 与 Prisma query engine 两个平台相关二进制，
//   必须在【Linux + 目标架构】环境里安装生产依赖 + prisma generate。
//   - 最稳：分别在 x86/arm 的 Linux（或飞牛设备 / buildx 目标架构容器）内运行本脚本；
//   - 在 macOS 上直接跑只会装到 darwin 原生模块，不能用于飞牛（脚本会据此 fail-fast）。
//   --arch 仅决定 manifest.platform 与校验，不会交叉编译原生模块。
//
// 设计参考 deploy/bin/package-release.mjs（白名单组装 + 禁带扫描），
// 但输出到 fnOS 包目录 deploy/fnos/gouxiangdb/app/server，并用网关子路径构建前端。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const packDir = path.join(here, "gouxiangdb");
const serverDir = path.join(packDir, "app", "server");
const publicDir = path.join(serverDir, "public");
const GATEWAY_PREFIX = "/app/gouxiangdb";

const args = process.argv.slice(2);
let arch = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--arch") arch = args[++i];
  else if (args[i] === "--help" || args[i] === "-h") {
    console.log("usage: build-fpk.mjs --arch <x86|arm>");
    process.exit(0);
  }
}
if (arch !== "x86" && arch !== "arm") {
  fail("--arch 必填且只能是 x86 或 arm");
}

const log = (m) => console.log(`[fnpack-build] ${m}`);
function fail(m) {
  console.error(`[fnpack-build] FAIL: ${m}`);
  process.exit(1);
}
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: "inherit", cwd: opts.cwd ?? repoRoot, env: opts.env });
  if (r.status !== 0) fail(`${cmd} ${argv.join(" ")} 退出码 ${r.status ?? "unknown"}`);
}
function rimraf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(s, d) { fs.mkdirSync(d, { recursive: true }); fs.cpSync(s, d, { recursive: true }); }
function copyFile(s, d) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }

// --- 平台守卫：原生模块必须来自目标 Linux 架构 -----------------------------------
if (process.platform !== "linux") {
  fail(
    `当前平台是 ${process.platform}，无法选取飞牛所需的 Linux/${arch} 原生模块 ` +
      `（better-sqlite3 / Prisma engine）。请在 Linux 同架构机或 ` +
      `docker buildx --platform linux/${arch === "arm" ? "arm64" : "amd64"} 容器内运行本脚本。`,
  );
}
const hostArch = process.arch; // linux: x64 | arm64
const wantArch = arch === "arm" ? "arm64" : "x64";
if (hostArch !== wantArch) {
  fail(`主机架构 ${hostArch} 与 --arch ${arch}（期望 ${wantArch}）不一致；请在目标架构 Linux 环境构建。`);
}

// --- 工具检查 -------------------------------------------------------------------
if (spawnSync("fnpack", ["--help"], { stdio: "ignore" }).status !== 0) {
  fail("未找到 fnpack CLI（参考飞牛开发者文档安装 1.2.3，并放入 PATH）。");
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const apiPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps", "api", "package.json"), "utf8"));
const version = rootPkg.version || "0.0.0-dev";
log(`版本 ${version}，目标 arch=${arch}（linux/${wantArch}），网关前缀 ${GATEWAY_PREFIX}`);

// --- 1) 构建 api（esbuild）与 web（网关子路径） -----------------------------------
log("构建 @gx/api（esbuild）");
run("pnpm", ["--filter", "@gx/api", "run", "build"]);
log(`构建 @gx/web（VITE_BASE_PATH=${GATEWAY_PREFIX}）`);
run("pnpm", ["--filter", "@gx/web", "run", "build"], {
  env: { ...process.env, VITE_BASE_PATH: GATEWAY_PREFIX },
});

// --- 2) 写 manifest.platform ----------------------------------------------------
const manifestPath = path.join(packDir, "manifest");
const manifest = fs.readFileSync(manifestPath, "utf8").replace(/^platform=.*$/m, `platform=${arch}`);
fs.writeFileSync(manifestPath, manifest);
log(`manifest.platform=${arch}`);

// --- 3) 组装 server/（白名单） ---------------------------------------------------
rimraf(serverDir);
fs.mkdirSync(serverDir, { recursive: true });
const srcApi = path.join(repoRoot, "apps", "api");

const distSrc = path.join(srcApi, "dist");
if (!fs.existsSync(path.join(distSrc, "index.js"))) fail("缺少 apps/api/dist/index.js");
copyDir(distSrc, path.join(serverDir, "dist"));
copyFile(path.join(srcApi, "prisma", "schema.prisma"), path.join(serverDir, "prisma", "schema.prisma"));
copyDir(path.join(srcApi, "prisma", "migrations"), path.join(serverDir, "prisma", "migrations"));
copyDir(path.join(srcApi, "scripts", "backup"), path.join(serverDir, "scripts", "backup"));

const webDist = path.join(repoRoot, "apps", "web", "dist");
if (!fs.existsSync(path.join(webDist, "index.html"))) fail("缺少 apps/web/dist/index.html");
copyDir(webDist, publicDir);

// 精简运行时 package.json：去 @gx/*，把 prisma CLI 提到 deps（自带 migrate 能力）。
const runtimeDeps = { ...(apiPkg.dependencies ?? {}) };
for (const k of Object.keys(runtimeDeps)) if (k.startsWith("@gx/")) delete runtimeDeps[k];
runtimeDeps.prisma = apiPkg.devDependencies?.prisma ?? "^5.22.0";
fs.writeFileSync(
  path.join(serverDir, "package.json"),
  `${JSON.stringify(
    {
      name: "gouxiangdb-fnos-server",
      version,
      private: true,
      type: "module",
      packageManager: rootPkg.packageManager ?? "pnpm@9.0.0",
      dependencies: runtimeDeps,
    },
    null,
    2,
  )}\n`,
);

// --- 4) 安装生产依赖（目标 Linux 架构原生模块）+ prisma generate ------------------
log("在 server/ 安装仅生产依赖（应取 linux/" + wantArch + " 的 better-sqlite3 prebuild）");
run("pnpm", ["install", "--prod", "--ignore-workspace"], { cwd: serverDir });
log("prisma generate（落地 linux/" + wantArch + " query engine）");
run("node", ["node_modules/prisma/build/index.js", "generate", "--schema=prisma/schema.prisma"], {
  cwd: serverDir,
  env: { ...process.env, DATABASE_URL: "file:./_fpk_generate_placeholder.db" },
});
rimraf(path.join(serverDir, "_fpk_generate_placeholder.db"));

// 原生模块架构自检：至少应存在 better-sqlite3 的 .node 与 prisma libquery engine。
function assertExists(globHint, predicate) {
  const found = predicate();
  if (!found) fail(`未找到期望的 ${globHint}（linux/${wantArch} 原生模块可能没装上）`);
  log(`找到 ${globHint}`);
}
assertExists("better-sqlite3 原生 .node", () => {
  const base = path.join(serverDir, "node_modules", ".pnpm");
  if (!fs.existsSync(base)) return fs.existsSync(path.join(serverDir, "node_modules", "better-sqlite3", "build", "Release"));
  return fs.readdirSync(base).some((d) => d.startsWith("better-sqlite3@"));
});

// --- 5) 禁带文件扫描 -------------------------------------------------------------
const FORBIDDEN = [
  /(^|\/)\.env$/i,
  /\.db(-wal|-shm)?$/i,
  /\.log$/i,
  /(^|\/)\.workbuddy($|\/)/i,
  /(^|\/)audit\.logl$/i,
];
const offenders = [];
(function scan(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(packDir, full);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules") continue;
      scan(full);
    } else if (FORBIDDEN.some((re) => re.test(rel) || re.test(ent.name))) {
      offenders.push(rel);
    }
  }
})(packDir);
if (offenders.length) fail(`包内含禁带文件：\n  ${offenders.join("\n  ")}`);
log("禁带文件扫描通过");

// --- 6) fnpack build ------------------------------------------------------------
log("fnpack build");
run("fnpack", ["build", "--directory", packDir]);
log(`完成：gouxiangdb ${version} ${arch} fpk 已生成（按 fnpack 输出位置查看）。`);
log("安装测试：appcenter-cli install-fpk <name>.fpk 或应用中心手动安装。");
