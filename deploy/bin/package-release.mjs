#!/usr/bin/env node
// deploy/bin/package-release.mjs — GouXiangDB 裸机发布物打包（M0 S8）。
//
// 在构建机产出可整体投递到 /srv/gouxiangdb/releases/<ts>/ 的自包含发布物：
//   release/
//     api/   dist/index.js(esbuild 扁平单文件) + prisma/{schema.prisma,migrations}
//            + 精简 package.json + 仅生产 node_modules(含已 generate 的 prisma client)
//     web/   vite build 静态产物
//     checksums.txt          全部文件 sha256（shasum -a 256 -c 校验）
//     gouxiangdb-release-<ts>.tar.gz
//
// 安全（关 E5 第三道闸）：采用“白名单逐目录拷贝”，绝不整目录拷 apps/api，
//   因此 .env / *.db* / *.log / .workbuddy / src / uploads 从构造上就进不来；
//   组装后再做一次禁带文件扫描兜底，命中即非零退出。
//
// 用法：node deploy/bin/package-release.mjs
// 前提：Node>=20、pnpm>=9、可访问 npm registry（安装生产依赖、prisma generate 引擎）。
// 交叉架构（在 mac 上打 linux 包）不支持原生引擎/prebuild 选择，见 docs/runbooks/deploy.md。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const releaseDir = path.join(repoRoot, "release");
const apiPkgPath = path.join(repoRoot, "apps", "api", "package.json");

const log = (m) => console.log(`[package] ${m}`);
const fail = (m) => {
  console.error(`[package] FAIL: ${m}`);
  process.exit(1);
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd ?? repoRoot, env: opts.env });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} 退出码 ${r.status ?? "unknown"}`);
}

function rimraf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// 读根/应用版本号作为发布版本（与 esbuild define 的 GX_VERSION 同源）。
const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const apiPkg = JSON.parse(fs.readFileSync(apiPkgPath, "utf8"));
const version = rootPkg.version || "0.0.0-dev";
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS（UTC）
const relName = `gouxiangdb-release-${version}-${stamp}`;

log(`版本 ${version}，时间戳 ${stamp}`);

// ---------------------------------------------------------------------------
// 1) 清理旧 release，构建 api（esbuild）与 web（vite）
// ---------------------------------------------------------------------------
rimraf(releaseDir);
fs.mkdirSync(path.join(releaseDir, "api"), { recursive: true });
fs.mkdirSync(path.join(releaseDir, "web"), { recursive: true });

log("构建 @gx/api（esbuild 扁平单文件）");
run("pnpm", ["--filter", "@gx/api", "run", "build"]);
log("构建 @gx/web（vite）");
run("pnpm", ["--filter", "@gx/web", "run", "build"]);

// ---------------------------------------------------------------------------
// 2) 组装 api/：只拷白名单（dist + prisma schema/migrations）
// ---------------------------------------------------------------------------
const relApi = path.join(releaseDir, "api");
const srcApi = path.join(repoRoot, "apps", "api");

const distSrc = path.join(srcApi, "dist");
// fail-fast 三入口存在性断言：缺任一随包 CLI（M6 mcp-stdio / M3-S11 nav-reconcile）即拒绝打包。
if (!fs.existsSync(path.join(distSrc, "index.js"))) fail("缺少 apps/api/dist/index.js，api 构建失败");
if (!fs.existsSync(path.join(distSrc, "mcp-stdio.js"))) fail("缺少 apps/api/dist/mcp-stdio.js，api 构建失败");
if (!fs.existsSync(path.join(distSrc, "nav-reconcile.js"))) fail("缺少 apps/api/dist/nav-reconcile.js，api 构建失败");
copyDir(distSrc, path.join(relApi, "dist"));

copyFile(path.join(srcApi, "prisma", "schema.prisma"), path.join(relApi, "prisma", "schema.prisma"));
copyDir(path.join(srcApi, "prisma", "migrations"), path.join(relApi, "prisma", "migrations"));

// S6 备份脚本随发布包发布：systemd backup timer 在目标机调
// `node scripts/backup/online-backup.mjs`（该脚本只依赖 node 内置 + better-sqlite3 +
// 同目录 lib.mjs；ESM 从脚本位置向上解析到 api/node_modules，路径 apiRoot=api 自洽）。
// 只带 backup 三个运行脚本，不带 build.mjs（构建只发生在构建机）。
copyDir(path.join(srcApi, "scripts", "backup"), path.join(relApi, "scripts", "backup"));

// 精简运行时 package.json：去掉已被 esbuild 内化的 @gx/* workspace 依赖；
// 把 prisma CLI（源工程在 devDeps）提入 deps，使发布包自带 migrate/generate 能力。
const runtimeDeps = { ...(apiPkg.dependencies ?? {}) };
for (const key of Object.keys(runtimeDeps)) {
  if (key.startsWith("@gx/")) delete runtimeDeps[key];
}
runtimeDeps.prisma = apiPkg.devDependencies?.prisma ?? "^5.22.0";
// M5/S2：sqlite-vec 必须作为【可选】依赖带进发布包，pnpm 才会按目标平台拉对应子包
// （vec0）。平台不支持/子包缺失时不阻断安装（optional），运行时 SearchStore 降级 fts-only。
const runtimeOptional = {};
if (apiPkg.optionalDependencies?.["sqlite-vec"]) {
  runtimeOptional["sqlite-vec"] = apiPkg.optionalDependencies["sqlite-vec"];
}
const runtimePkg = {
  name: "gouxiangdb-api-runtime",
  version,
  private: true,
  type: "module",
  packageManager: rootPkg.packageManager ?? "pnpm@9.0.0",
  dependencies: runtimeDeps,
  ...(Object.keys(runtimeOptional).length ? { optionalDependencies: runtimeOptional } : {}),
};
fs.writeFileSync(path.join(relApi, "package.json"), `${JSON.stringify(runtimePkg, null, 2)}\n`);

// ---------------------------------------------------------------------------
// 3) 发布目录内独立安装生产依赖（--ignore-workspace：不读 monorepo workspace/lock）
// ---------------------------------------------------------------------------
log("在发布目录安装仅生产依赖（better-sqlite3 用包内跨平台 prebuilds，无需编译）");
run("pnpm", ["install", "--prod", "--ignore-workspace"], { cwd: relApi });

log("在发布目录 prisma generate（生成与本机平台匹配的 query engine/client）");
run("node", ["node_modules/prisma/build/index.js", "generate", "--schema=prisma/schema.prisma"], {
  cwd: relApi,
  env: { ...process.env, DATABASE_URL: "file:./_package_generate_placeholder.db" },
});
rimraf(path.join(relApi, "_package_generate_placeholder.db"));

// M5/S2：把已安装的 vec0 显式拷到发布物白名单 api/native/<triplet>/（§12）。
// 发布目录已 --prod 安装（含 sqlite-vec 可选依赖与当前平台子包），故 --app-dir 指向 relApi。
// 不支持平台/子包缺失时脚本仅 SKIP 不 fail（该目标机纯 FTS 服役，H6/H8）。
run("node", [
  path.join(srcApi, "scripts", "native", "copy-vec-native.mjs"),
  "--dest", relApi, "--app-dir", relApi,
], { cwd: repoRoot });

// ---------------------------------------------------------------------------
// 4) 组装 web/：只拷 vite 产物
// ---------------------------------------------------------------------------
const webDist = path.join(repoRoot, "apps", "web", "dist");
if (!fs.existsSync(path.join(webDist, "index.html"))) fail("缺少 apps/web/dist/index.html，web 构建失败");
copyDir(webDist, path.join(releaseDir, "web"));

// ---------------------------------------------------------------------------
// 5) 禁带文件兜底扫描（白名单已隔离，这里再 fail-fast 一次，供审计取证）
// ---------------------------------------------------------------------------
const FORBIDDEN = [
  /(^|\/)\.env$/i,
  /\.db(-wal|-shm)?$/i,
  /\.log$/i,
  /(^|\/)\.workbuddy($|\/)/i,
  /(^|\/)audit\.logl$/i,
];
const offenders = [];
(function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(releaseDir, full);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue; // 依赖树不扫（禁带物只可能来自我们拷贝的产物）
      scan(full);
    } else if (FORBIDDEN.some((re) => re.test(rel) || re.test(entry.name))) {
      offenders.push(rel);
    }
  }
})(releaseDir);
if (offenders.length > 0) fail(`发布物含禁带文件：\n  ${offenders.join("\n  ")}`);
log("禁带文件扫描通过（无 .env / *.db* / *.log / .workbuddy / audit.logl）");

// ---------------------------------------------------------------------------
// 6) 生成 checksums.txt（shasum 格式，路径相对 release/）
// ---------------------------------------------------------------------------
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
// 收集真实文件：pnpm 的 node_modules 顶层包名是指向 .pnpm/ 真实目录的（相对）符号链接。
// 符号链接不作为独立文件哈希——其目标字节都在 .pnpm/ 下，哈希真实文件即完整覆盖；
// 链接结构由 pnpm 生成、tar 原样保留，deploy 端 shasum -c 跟随链接读到同一内容。
const files = [];
(function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) collect(full);
    else if (entry.isFile()) files.push(full);
  }
})(path.join(releaseDir, "api"));
(function collectWeb(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) collectWeb(full);
    else if (entry.isFile()) files.push(full);
  }
})(path.join(releaseDir, "web"));

const lines = files
  .map((f) => `${sha256(f)}  ${path.relative(releaseDir, f)}`)
  .sort((a, b) => a.localeCompare(b));
fs.writeFileSync(path.join(releaseDir, "checksums.txt"), `${lines.join("\n")}\n`);
log(`checksums.txt 已生成（${lines.length} 个文件）`);

// ---------------------------------------------------------------------------
// 7) 打 tar.gz（在 release/ 之上一层打包，解压即 api/ web/ checksums.txt）
// ---------------------------------------------------------------------------
const tarball = path.join(releaseDir, `${relName}.tar.gz`);
run("tar", ["-czf", tarball, "-C", releaseDir, "api", "web", "checksums.txt"]);
log(`发布包 ${path.relative(repoRoot, tarball)}`);

const du = (p) => {
  const r = spawnSync("du", ["-sh", p], { cwd: releaseDir });
  return r.status === 0 ? r.stdout.toString().split("\t")[0] : "?";
};
log("完成：");
log(`  api/  ${du(path.join(releaseDir, "api"))}`);
log(`  web/  ${du(path.join(releaseDir, "web"))}`);
log(`  校验：cd release && shasum -a 256 -c checksums.txt`);
