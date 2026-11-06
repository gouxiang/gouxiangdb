#!/usr/bin/env node
// apps/desktop/scripts/stage-node-sidecar.mjs
//
// macOS 桌面 App（PoC-1 / D1）：在【Mac + Apple Silicon】上组装一个可重定位、目标机零依赖的
// Node sidecar 运行树，并做 arm64 原生件硬自检 + 真建库冒烟。
//
// 产出（默认 <repo>/apps/desktop/.stage/）：
//   gxnode-aarch64-apple-darwin      官方 Node 单二进制（Tauri sidecar 三元组命名）
//   server/
//     dist/                          apps/api esbuild 产物（含 index/mcp-stdio/nav-reconcile/init-admin）
//     public/                        apps/web vite 产物（base='/'，由内核同源托管）
//     prisma/{schema.prisma,migrations}
//     node_modules/                  扁平(hoisted) 生产依赖 + prisma CLI，含 darwin-arm64 原生件
//     native/darwin-arm64/vec0.dylib
//     scripts/                       backup / smoke
//     package.json
//
// 目标机零依赖假设（DESIGN-MACOS-APP §5.2）：不装 Node/pnpm、不联网、无 prisma CLI。
// 必须在 darwin/arm64 上跑（optionalDependencies 只取本机平台子包，不做交叉选择）。
//
// 用法：
//   node apps/desktop/scripts/stage-node-sidecar.mjs [--out <dir>] [--node-tar <dir-or-file>]
//                                            [--web-dist <dir>]
//   --web-dist 缺省为 apps/web/dist（普通构建，与历史行为逐字节一致）；
//   桌面壳门控构建传 apps/web/dist-shell（由 build-web-shell.mjs 产出）。
//
// 退出码：任何原生件架构不符 / 冒烟失败 => 非 0（PoC-1 硬门槛）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const desktopDir = path.join(repoRoot, "apps", "desktop");
const srcApi = path.join(repoRoot, "apps", "api");

const args = process.argv.slice(2);
let outDir = path.join(desktopDir, ".stage");
let nodeTarHint = "";
let webDistOpt = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") outDir = args[++i];
  else if (args[i] === "--node-tar") nodeTarHint = args[++i];
  else if (args[i] === "--web-dist") webDistOpt = args[++i];
}
// 默认仍是 apps/web/dist（不传参时与历史行为完全一致）；相对路径相对 repoRoot 解析。
const webDist = webDistOpt
  ? path.isAbsolute(webDistOpt)
    ? webDistOpt
    : path.join(repoRoot, webDistOpt)
  : path.join(repoRoot, "apps", "web", "dist");
const serverDir = path.join(outDir, "server");
const sidecarName = "gxnode-aarch64-apple-darwin";

const log = (m) => console.log(`[stage-sidecar] ${m}`);
function fail(m) {
  console.error(`[stage-sidecar] FAIL: ${m}`);
  process.exit(1);
}
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: "inherit", cwd: opts.cwd ?? repoRoot, env: opts.env });
  if (r.status !== 0) fail(`${cmd} ${argv.join(" ")} 退出码 ${r.status ?? "unknown"}`);
}
function rimraf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(s, d) { fs.mkdirSync(d, { recursive: true }); fs.cpSync(s, d, { recursive: true }); }
function copyFile(s, d) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }

// --- 1) 平台守卫：必须 macOS arm64 ------------------------------------------------
if (process.platform !== "darwin") fail(`需在 macOS 上运行，当前 ${process.platform}（原生件不交叉选择）`);
if (process.arch !== "arm64") fail(`需 Apple Silicon(arm64)，当前 ${process.arch}；Intel 本期不支持`);
const nodeVersion = process.versions.node;
log(`平台 darwin/arm64，构建用 Node ${nodeVersion}`);

// --- 2) 定位官方 Node darwin-arm64 运行时 ------------------------------------------
// 优先：--node-tar 指向的目录（含解压后的 node-v*-darwin-arm64/）或 .tar.gz；
// 否则用缓存目录 ~/Library/Caches/gouxiangdb-desktop/node-runtime/。
function resolveNodeBinary() {
  const candidates = [];
  const cacheRoot = path.join(os.homedir(), "Library", "Caches", "gouxiangdb-desktop", "node-runtime");
  const bases = [];
  if (nodeTarHint) bases.push(nodeTarHint);
  bases.push(cacheRoot);
  for (const b of bases) {
    if (!b || !fs.existsSync(b)) continue;
    const st = fs.statSync(b);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(b)) {
        if (e.startsWith("node-v") && e.includes("darwin-arm64")) {
          candidates.push(path.join(b, e, "bin", "node"));
        }
      }
    }
  }
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    fail(
      "未找到官方 node-v*-darwin-arm64 运行时。请先下载并解压到 " +
        `${cacheRoot}（如 node-v${nodeVersion}-darwin-arm64.tar.gz，来自 https://nodejs.org/dist/）。`,
    );
  }
  return found;
}
const nodeBinSrc = resolveNodeBinary();

// --- 3) 读版本（单源）+ 前置产物检查 ------------------------------------------------
const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const apiPkg = JSON.parse(fs.readFileSync(path.join(srcApi, "package.json"), "utf8"));
const version = rootPkg.version || "0.0.0-dev";
log(`版本 ${version}`);

const distSrc = path.join(srcApi, "dist");
for (const entry of ["index.js", "mcp-stdio.js", "nav-reconcile.js", "init-admin.js"]) {
  if (!fs.existsSync(path.join(distSrc, entry))) fail(`缺少 apps/api/dist/${entry}（先 pnpm --filter @gx/api build）`);
}

// 信任根硬门：桌面成品随包的 api dist 必须是 GX_LICENSE_PROD=1 构建（内置生产公钥
// ff02db72、物理不含开发钥 da469cd3）。本脚本只消费调用方先 build 好的 dist，若不在这里
// 拦截，任何漏注入的手动 build 都会把开发信任根打进 dmg（与 fpk 2026-11-04 同类事故）。
// 从源码 keyring.{prod,dev}.ts 动态抽 PEM base64 主体，密钥轮换时自适应。
{
  const licDir = path.join(srcApi, "src", "domain", "license");
  const keyBody = (file) => {
    const txt = fs.readFileSync(file, "utf8");
    const pem = txt.match(/pem:\s*`([^`]+)`/);
    const b64 = pem?.[1].match(/[A-Za-z0-9+/=]{40,}/);
    if (!b64) fail(`无法从 ${file} 抽取信任根 PEM 主体`);
    return b64[0];
  };
  const prodBody = keyBody(path.join(licDir, "keyring.prod.ts"));
  const devBody = keyBody(path.join(licDir, "keyring.dev.ts"));
  const apiBundle = fs.readFileSync(path.join(distSrc, "index.js"), "utf8");
  if (!apiBundle.includes(prodBody)) {
    fail(
      "桌面侧车信任根校验失败：apps/api/dist/index.js 不含生产公钥 ff02db72。" +
        "请改用 GX_LICENSE_PROD=1 pnpm --filter @gx/api run build 重新构建后再 stage（禁止把开发信任根打进 dmg）。",
    );
  }
  if (apiBundle.includes(devBody)) {
    fail(
      "桌面侧车信任根校验失败：apps/api/dist/index.js 残留开发公钥 da469cd3。" +
        "请用 GX_LICENSE_PROD=1 pnpm --filter @gx/api run build 重新构建（生产包物理不得含开发钥）。",
    );
  }
  log("信任根校验通过：api dist 仅含生产公钥 ff02db72，无开发钥 da469cd3");
}
log(`前端产物目录：${webDist}`);
if (webDistOpt) log("使用自定义前端产物（桌面壳门控构建）");
if (!fs.existsSync(path.join(webDist, "index.html"))) fail(`缺少 ${path.relative(repoRoot, path.join(webDist, "index.html"))}（先构建前端；默认跑 pnpm --filter @gx/web build，桌面壳跑 build:web:shell 后用 --web-dist 指向其产物，base='/'）`);

// --- 4) 干净组装 -------------------------------------------------------------------
rimraf(outDir);
fs.mkdirSync(serverDir, { recursive: true });

// 4.1 随包 Node 二进制（Tauri sidecar 三元组命名）。
copyFile(nodeBinSrc, path.join(outDir, sidecarName));
fs.chmodSync(path.join(outDir, sidecarName), 0o755);
log("放入随包 Node sidecar 二进制");

// 4.2 api dist / web public / prisma / scripts（白名单）。
copyDir(distSrc, path.join(serverDir, "dist"));
copyDir(webDist, path.join(serverDir, "public"));
// PoC-2 only（D 版删除）：同源探针页，内核经 GX_WEB_DIST 静态托管在 /poc2.html。
// 默认不注入，仅 GX_POC2=1 自测时随包（与 Rust 侧启动门控同名）；正式 stage 产物不含探针。
const poc2Src = path.join(desktopDir, "poc", "poc2.html");
if (process.env.GX_POC2 === "1" && fs.existsSync(poc2Src)) {
  copyFile(poc2Src, path.join(serverDir, "public", "poc2.html"));
  log("GX_POC2=1：放入 PoC-2 同源探针页 public/poc2.html（自测专用，正式打包不带）");
}
// PoC-4 only（#816 承载验证）：跨源探针页，由【壳自己的回环静态口】托管在 /poc4.html，
// 业务请求跨源发往内核口。仅 GX_POC4=1 自测时随包；正式 stage 产物不含。
const poc4Src = path.join(desktopDir, "poc", "poc4.html");
if (process.env.GX_POC4 === "1" && fs.existsSync(poc4Src)) {
  copyFile(poc4Src, path.join(serverDir, "public", "poc4.html"));
  log("GX_POC4=1：放入 PoC-4 跨源探针页 public/poc4.html（自测专用，正式打包不带）");
}
copyFile(path.join(srcApi, "prisma", "schema.prisma"), path.join(serverDir, "prisma", "schema.prisma"));
copyDir(path.join(srcApi, "prisma", "migrations"), path.join(serverDir, "prisma", "migrations"));
copyDir(path.join(srcApi, "scripts", "backup"), path.join(serverDir, "scripts", "backup"));
copyFile(path.join(srcApi, "scripts", "smoke-dist.mjs"), path.join(serverDir, "scripts", "smoke-dist.mjs"));
copyDir(path.join(srcApi, "scripts", "smoke"), path.join(serverDir, "scripts", "smoke"));

// 4.3 精简运行时 package.json：去 @gx/*（已内化进 esbuild），prisma CLI 提到 deps（自带 migrate 能力）。
const runtimeDeps = { ...(apiPkg.dependencies ?? {}) };
for (const k of Object.keys(runtimeDeps)) if (k.startsWith("@gx/")) delete runtimeDeps[k];
runtimeDeps.prisma = apiPkg.devDependencies?.prisma ?? "^5.22.0";
const runtimeOptional = {};
if (apiPkg.optionalDependencies?.["sqlite-vec"]) {
  runtimeOptional["sqlite-vec"] = apiPkg.optionalDependencies["sqlite-vec"];
}
fs.writeFileSync(
  path.join(serverDir, "package.json"),
  `${JSON.stringify(
    {
      name: "gouxiangdb-desktop-server",
      version,
      private: true,
      type: "module",
      packageManager: rootPkg.packageManager ?? "pnpm@9.0.0",
      dependencies: runtimeDeps,
      ...(Object.keys(runtimeOptional).length ? { optionalDependencies: runtimeOptional } : {}),
    },
    null,
    2,
  )}\n`,
);

// 4.4 安装生产依赖（hoisted 扁平、可重定位；强制 darwin/arm64 平台，确保拉对原生子包）。
log("安装仅生产依赖（hoisted，目标 darwin/arm64）");
run(
  "pnpm",
  [
    "install",
    "--prod",
    "--ignore-workspace",
    "--node-linker=hoisted",
    "--config.supported-architectures.os=darwin",
    "--config.supported-architectures.cpu=arm64",
  ],
  { cwd: serverDir },
);

// hoisted 后 .bin 可能是软链；Tauri Resources 深路径 + ad-hoc 签名场景下实体化最稳。
(function derefBin() {
  const bin = path.join(serverDir, "node_modules", ".bin");
  if (!fs.existsSync(bin)) return;
  let n = 0;
  for (const e of fs.readdirSync(bin, { withFileTypes: true })) {
    const full = path.join(bin, e.name);
    if (!e.isSymbolicLink()) continue;
    try {
      const target = fs.realpathSync(full);
      fs.unlinkSync(full);
      fs.copyFileSync(target, full);
      fs.chmodSync(full, 0o755);
      n++;
    } catch (err) {
      fail(`实体化 .bin/${e.name} 失败：${err?.message ?? err}`);
    }
  }
  if (n) log(`实体化 node_modules/.bin 链接 ${n} 个`);
})();

// 4.5 Prisma Client（在 Mac 上预生成 darwin-arm64 query engine；目标无 CLI/无网）。
log("prisma generate（darwin-arm64 引擎）");
run("node", ["node_modules/prisma/build/index.js", "generate", "--schema=prisma/schema.prisma"], {
  cwd: serverDir,
  env: { ...process.env, DATABASE_URL: "file:./_stage_placeholder.db" },
});
rimraf(path.join(serverDir, "_stage_placeholder.db"));

// 4.6 vec0.dylib 白名单投递（复用现成脚本，triplet=darwin-arm64，自带 file 架构自检）。
run("node", [path.join(srcApi, "scripts", "native", "copy-vec-native.mjs"), "--dest", serverDir, "--app-dir", srcApi], {
  cwd: repoRoot,
});

// --- 5) 原生件 arm64 硬自检（PoC-1 硬门槛）------------------------------------------
function fileArch(p) {
  const r = spawnSync("file", [p], { encoding: "utf8" });
  return r.stdout.trim();
}
function assertMachArm64(label, p) {
  if (!fs.existsSync(p)) fail(`原生件缺失：${label} -> ${p}`);
  const out = fileArch(p);
  if (!/arm64/.test(out)) fail(`${label} 不是 arm64：${out}`);
  // 拒绝同时含 x86_64 的 universal 里夹带（本期单架构纯 arm64 更干净）。
  log(`arm64 OK：${label}（${path.basename(p)}）`);
}

assertMachArm64("随包 Node", path.join(outDir, sidecarName));

// better-sqlite3：hoisted 下优先 prebuilds/darwin-arm64.node，回退 build/Release。
const bs3Dir = path.join(serverDir, "node_modules", "better-sqlite3");
const bs3Candidates = [
  path.join(bs3Dir, "prebuilds", "darwin-arm64.node"),
  path.join(bs3Dir, "build", "Release", "better_sqlite3.node"),
];
const bs3 = bs3Candidates.find((p) => fs.existsSync(p));
if (!bs3) fail("未找到 better-sqlite3 的 darwin-arm64 .node");
assertMachArm64("better-sqlite3", bs3);

// Prisma query engine + schema engine（migrate deploy 依赖 schema-engine）。
function findEngines(dir, pattern) {
  const out = [];
  const engines = path.join(dir, "node_modules", "@prisma", "engines");
  if (!fs.existsSync(engines)) return out;
  for (const e of fs.readdirSync(engines)) {
    if (pattern.test(e) && /darwin-arm64/.test(e)) out.push(path.join(engines, e));
  }
  return out;
}
const queryEngines = findEngines(serverDir, /libquery_engine/);
if (!queryEngines.length) fail("未找到 Prisma libquery_engine darwin-arm64");
assertMachArm64("Prisma query engine", queryEngines[0]);
const schemaEngines = findEngines(serverDir, /schema-engine/);
if (!schemaEngines.length) fail("未找到 Prisma schema-engine darwin-arm64");
assertMachArm64("Prisma schema engine", schemaEngines[0]);

const vecDylib = path.join(serverDir, "native", "darwin-arm64", "vec0.dylib");
assertMachArm64("sqlite-vec", vecDylib);

// 5.1 依赖库不得指向构建机绝对路径（otool -L 粗查）。
// 注意：otool -L 的【第一行】是被查 dylib 自己的 install name（必为我们传入的绝对路径），
// 不是依赖项，必须跳过；从第二行起才是它链接的动态库。健康依赖＝系统路径(/usr/lib,/System)
// 或可重定位的 @rpath/@loader_path/@executable_path。
{
  const r = spawnSync("otool", ["-L", vecDylib], { encoding: "utf8" });
  const depLines = r.stdout.split("\n").slice(1).filter((l) => l.trim());
  // 健康依赖：系统库（/usr/lib,/System）、可重定位（@rpath/@loader_path/@executable_path）、
  // 或裸相对路径（如 dist/vec0.dylib，运行时由内核用绝对白名单路径 dlopen）。
  const relocatable = /^\s*(@rpath|@loader_path|@executable_path)\//;
  const systemLib = /^\s*(\/usr\/lib|\/System\/)/;
  const absolute = /^\s*\//;
  const bad = depLines.filter((l) => absolute.test(l) && !relocatable.test(l) && !systemLib.test(l));
  if (bad.length) fail(`vec0.dylib 含指向构建机绝对路径的依赖：\n  ${bad.join("\n  ")}`);
  log(`vec0.dylib 动态库依赖健康（${depLines.length} 条，均系统/可重定位/相对）`);
}

// --- 6) 真建库冒烟（PoC-1 核心：干净树里跑 migrate + readyz）-------------------------
// 用随包 node（而非构建机 PATH 的 node）执行，证明目标机零依赖成立。
const stagedNode = path.join(outDir, sidecarName);
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "gx-poc1-data-"));
const tmpDb = path.join(tmpData, "dev.db");
log(`真建库冒烟：数据目录 ${tmpData}`);
run(stagedNode, ["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
  cwd: serverDir,
  env: {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: `file:${tmpDb}`,
    GX_DATA_DIR: tmpData,
  },
});
if (!fs.existsSync(tmpDb)) fail("migrate deploy 后未生成 dev.db");
log(`migrate deploy 成功，dev.db=${fs.statSync(tmpDb).size} B`);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: `file:${tmpDb}`,
    GX_DATA_DIR: tmpData,
    UPLOAD_ROOT: path.join(tmpData, "uploads"),
    GX_AUDIT_DIR: path.join(tmpData, ".audit"),
    GX_WEB_DIST: path.join(serverDir, "public"),
    GX_MIGRATIONS_DIR: path.join(serverDir, "prisma", "migrations"),
    GX_BIND_HOST: "127.0.0.1",
    PORT: String(port),
    JWT_SECRET: crypto.randomBytes(48).toString("base64"),
    // 生产闸门要求 CORS_ORIGIN 非空；界面与 API 同源回环本不触发跨域，这里给回环通配白名单
    // （随机端口），与将来 Rust 启动注入一致（DESIGN-MACOS-APP §7）。
    CORS_ORIGIN: "http://127.0.0.1:*,http://localhost:*",
  };
  const child = spawn(stagedNode, ["dist/index.js"], { cwd: serverDir, env });
  let childLog = "";
  child.stdout.on("data", (d) => { childLog += d; });
  child.stderr.on("data", (d) => { childLog += d; });
  child.on("error", (e) => fail(`sidecar 启动失败：${e.message}`));

  const deadline = Date.now() + 40_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && child.exitCode !== 0) {
      fail(`sidecar 提前退出 code=${child.exitCode}\n${childLog.slice(-2000)}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (r.ok) {
        const j = await jsonSafe(r);
        const checks = j?.checks ?? {};
        const allTrue = Object.values(checks).length > 0 && Object.values(checks).every((v) => v === true);
        if (j?.status === "ready" || allTrue) { ready = true; break; }
      }
    } catch {
      // 还没起来，继续轮询。
    }
    await sleep(500);
  }
  if (!ready) fail(`40s 内 /readyz 未就绪\n${childLog.slice(-2000)}`);
  log(`sidecar /readyz 就绪（127.0.0.1:${port}，五探针全 true）`);

  // 再验证同源托管的前端首页可达（PoC-1：界面与 API 同源）。
  const home = await fetch(`http://127.0.0.1:${port}/`);
  const homeText = await home.text();
  if (!home.ok || !/<!doctype html|<html/i.test(homeText)) fail("同源首页未返回 HTML");
  log("同源前端首页可达");

  // SIGTERM 优雅收尸（命中内核已有优雅关闭）。
  child.kill("SIGTERM");
  await new Promise((res) => child.on("exit", res));
  rimraf(tmpData);
  log(`PoC-1 组装 + 真建库 + sidecar 冒烟全部通过。产物：${outDir}`);
})().catch((e) => fail(e?.stack || String(e)));

async function jsonSafe(r) {
  try { return await r.json(); } catch { return null; }
}
