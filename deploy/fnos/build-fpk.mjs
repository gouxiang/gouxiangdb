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
// 但输出到 fnOS 包目录 deploy/fnos/gouxiangdb/app/server。0.2.5 起前端按【根路径】构建：
// fpk 改为独立端口服务（app/ui/config 的 port=${wizard_port}），页面与 API 同源在
// http://NAS:端口，不再使用 /cgi/ThirdParty/... 子路径。

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
// 0.2.5 起 fpk 为【独立端口服务】：app/ui/config 用 "port":"${wizard_port}" 让门户跨源
// iframe 嵌入应用自己的端口，页面与 API 同源在 http://NAS:端口（根路径）。因此前端按
// vite 默认 base="/" 构建，index.html 资源走 /assets/...、API 走同源 /api/...。
// 历史 CGI 前缀（/cgi/ThirdParty/gouxiangdb/index.cgi/）已废弃，index.cgi 不再打包。
const DEFAULT_PORT = "3001";
const PORT_ENTRY_URL = "/";
const brandPngDir = path.join(repoRoot, "branding", "app-icon", "png");

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

// 应用更新只读令牌占位符早检（设计稿 docs/design/2026-10-app-update/DESIGN.md §8.2 / D1）：
// cmd/install_callback 里必须仍是占位符 __GX_UPDATE_TOKEN__。若上次构建被强杀导致真实令牌
// 残留在源模板，这里 fail-fast，避免把令牌打进 git 或二次污染（真正替换发生在 fnpack 前一刻）。
{
  const tpl = path.join(packDir, "cmd", "install_callback");
  const txt = fs.existsSync(tpl) ? fs.readFileSync(tpl, "utf8") : "";
  if (!txt.includes("__GX_UPDATE_TOKEN__")) {
    fail(
      "deploy/fnos/gouxiangdb/cmd/install_callback 缺少占位符 __GX_UPDATE_TOKEN__" +
        "（疑似真实令牌残留进了源模板）。请先把该行恢复为 GX_UPDATE_TOKEN=__GX_UPDATE_TOKEN__，" +
        "切勿把任何真实令牌提交进仓库。",
    );
  }
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const apiPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "apps", "api", "package.json"), "utf8"));
const version = rootPkg.version || "0.0.0-dev";
log(`版本 ${version}，目标 arch=${arch}（linux/${wantArch}），独立端口入口（默认 ${DEFAULT_PORT}，根路径构建）`);

// --- 1) 构建 api（esbuild）与 web（根路径，独立端口同源） -----------------------------------
log("构建 @gx/api（esbuild）");
run("pnpm", ["--filter", "@gx/api", "run", "build"]);
log("构建 @gx/web（根路径 base=/，独立端口下页面与 /api 同源）");
run("pnpm", ["--filter", "@gx/web", "run", "build"], {
  env: { ...process.env, VITE_BASE_PATH: "/" },
});

// --- 2) 写 manifest.platform / manifest.version -----------------------------------
// version 必须和 platform 一样由 rootPkg 统一重写，不能留在 manifest 里手改：
// 2026-09-18 真机实证——手工把 manifest 改成 0.1.1 后装上，应用中心显示 0.1.1，
// 但 /healthz 与 /readyz 仍报 "version":"0.1.0"（dist 内版本来自 rootPkg.version），
// 两个版本各说各话，出事故时无法判断线上跑的到底是哪个包。
const manifestPath = path.join(packDir, "manifest");
const manifestRaw = fs.readFileSync(manifestPath, "utf8");
const manifest = manifestRaw
  .replace(/^platform\s*=.*$/m, `platform=${arch}`)
  .replace(/^version\s*=.*$/m, `version               = ${version}`);
if (!/^version\s*=/m.test(manifestRaw)) fail("manifest 缺少 version 行，无法统一版本真相源");
fs.writeFileSync(manifestPath, manifest);
log(`manifest.platform=${arch}，manifest.version=${version}`);

// --- 3) 组装 server/（白名单） ---------------------------------------------------
rimraf(serverDir);
fs.mkdirSync(serverDir, { recursive: true });
const srcApi = path.join(repoRoot, "apps", "api");

const distSrc = path.join(srcApi, "dist");
// fail-fast 三入口断言：mcp-stdio（M6）/nav-reconcile（M3-S11 迁移后 path 重算）必须随包。
if (!fs.existsSync(path.join(distSrc, "index.js"))) fail("缺少 apps/api/dist/index.js");
if (!fs.existsSync(path.join(distSrc, "mcp-stdio.js"))) fail("缺少 apps/api/dist/mcp-stdio.js");
if (!fs.existsSync(path.join(distSrc, "nav-reconcile.js"))) fail("缺少 apps/api/dist/nav-reconcile.js");
// 第四入口：首次部署超级管理员初始化（install_callback 在迁移后调用；缺失会导致安装失败）。
if (!fs.existsSync(path.join(distSrc, "init-admin.js"))) fail("缺少 apps/api/dist/init-admin.js");
copyDir(distSrc, path.join(serverDir, "dist"));
copyFile(path.join(srcApi, "prisma", "schema.prisma"), path.join(serverDir, "prisma", "schema.prisma"));
copyDir(path.join(srcApi, "prisma", "migrations"), path.join(serverDir, "prisma", "migrations"));
copyDir(path.join(srcApi, "scripts", "backup"), path.join(serverDir, "scripts", "backup"));
// 产物冒烟脚本（S-smoke）：下方在 hoisted prod 环境真跑 dist/index.js + 静态扫描全部产物。
copyFile(
  path.join(srcApi, "scripts", "smoke-dist.mjs"),
  path.join(serverDir, "scripts", "smoke-dist.mjs"),
);
copyDir(path.join(srcApi, "scripts", "smoke"), path.join(serverDir, "scripts", "smoke"));

const webDist = path.join(repoRoot, "apps", "web", "dist");
if (!fs.existsSync(path.join(webDist, "index.html"))) fail("缺少 apps/web/dist/index.html");
copyDir(webDist, publicDir);

// 精简运行时 package.json：去 @gx/*，把 prisma CLI 提到 deps（自带 migrate 能力）。
const runtimeDeps = { ...(apiPkg.dependencies ?? {}) };
for (const k of Object.keys(runtimeDeps)) if (k.startsWith("@gx/")) delete runtimeDeps[k];
runtimeDeps.prisma = apiPkg.devDependencies?.prisma ?? "^5.22.0";
// M5/S2：sqlite-vec 作为可选依赖带进 server/，安装时按目标 linux 架构拉 vec0 子包；
// 不支持平台/子包缺失不阻断安装，运行时 SearchStore 降级 fts-only（H6/H8）。
const runtimeOptional = {};
if (apiPkg.optionalDependencies?.["sqlite-vec"]) {
  runtimeOptional["sqlite-vec"] = apiPkg.optionalDependencies["sqlite-vec"];
}
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
      ...(Object.keys(runtimeOptional).length ? { optionalDependencies: runtimeOptional } : {}),
    },
    null,
    2,
  )}\n`,
);

// --- 4) 安装生产依赖（目标 Linux 架构原生模块）+ prisma generate ------------------
// 【--node-linker=hoisted 是硬要求，不是风格选择】（2026-09-18 飞牛真机实测）：
//   默认 pnpm 布局会在 app/server/node_modules 下产生 .pnpm/<pkg>@<ver>_<peer>/… 的
//   **深层目录 + 274 个符号链接**（本仓实测 5373 条目 / 938 目录 / 4161 文件）。
//   携带该布局的 fpk 在 fnOS 1.2.0604 上安装必定失败：
//     [Error] code 10234 — set app dir permissions failed: installType=volume
//     appname=<name>: acl_get_file failed
//   （失败点：app.tgz 已解压到 /vol1/appcenter-downloads/<name>-<ver>-tpk，
//     但 /vol1/@appcenter/<name> 始终建不出来 → 应用目录设 ACL 阶段失败。）
//   对照实验（同一台设备、同一个 fnpack 1.2.1）：
//     模板空包（68K）           → 成功
//     模板 + 仅 dist（1.4M）    → 成功
//     模板 + 仅 node_modules@pnpm 默认布局（142M/5373 条目）→ 失败（同 10234）
//     模板 + 5000 个相对符号链接 → 成功（说明不是"链接多"本身）
//   hoisted 布局是扁平真实目录：无 .pnpm、无符号链接、路径深度大幅下降，
//   实测可装上。代价是 node_modules 体积变大（依赖去重由 pnpm 的扁平提升替代）。
log("在 server/ 安装仅生产依赖（hoisted 扁平布局，应取 linux/" + wantArch + " 的 better-sqlite3 prebuild）");
run("pnpm", ["install", "--prod", "--ignore-workspace", "--node-linker=hoisted"], { cwd: serverDir });

// hoisted 后只剩 node_modules/.bin 下的少量 shim 链接，这里一并实体化，
// 目标是 node_modules 内【零符号链接】（飞牛对含链接的应用目录设 ACL 会失败，见上）。
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
log("prisma generate（落地 linux/" + wantArch + " query engine）");
run("node", ["node_modules/prisma/build/index.js", "generate", "--schema=prisma/schema.prisma"], {
  cwd: serverDir,
  env: { ...process.env, DATABASE_URL: "file:./_fpk_generate_placeholder.db" },
});
rimraf(path.join(serverDir, "_fpk_generate_placeholder.db"));

// M5/S2：vec0 白名单拷贝到 server/native/<linux-triplet>/（§12，fpk 基准 server/native/...）。
// 已在目标 linux 架构环境，脚本取 process 平台子包；平台无子包时仅 SKIP（纯 FTS），不 fail。
run("node", [
  path.join(srcApi, "scripts", "native", "copy-vec-native.mjs"),
  "--dest", serverDir, "--app-dir", serverDir,
], { cwd: repoRoot });
// 提示性自检：native/<triplet>/vec0.so 存在即记录；缺失仅 warn（降级 fts-only 合法），不 fail 打包。
{
  const nativeBase = path.join(serverDir, "native");
  const hasVec = fs.existsSync(nativeBase)
    && fs.readdirSync(nativeBase, { withFileTypes: true }).some(
      (d) => d.isDirectory() && fs.existsSync(path.join(nativeBase, d.name, "vec0.so")),
    );
  if (hasVec) log("找到 server/native/<triplet>/vec0.so");
  else console.warn("[fnpack-build] 未生成 server/native/<triplet>/vec0.so，运行时降级 fts-only");
}

// --- 5.4) 产物冒烟（hoisted prod node_modules 真环境） --------------------------------
// build 只打包不执行，挡不住 ws 那类「CJS 内化进 ESM -> 真机启动崩」。脚本自带临时库 migrate +
// 临时端口 + 临时数据目录（不碰 server 真实/挂载数据）+ 30s 预算 + 收尸，并静态扫描全部产物。
log("产物冒烟：真跑 dist/index.js 到 /readyz + 静态扫描 dist/*.js");
run("node", [path.join(serverDir, "scripts", "smoke-dist.mjs")], { cwd: serverDir });

// --- 5.5) 入口一致性自检（白屏闸门） ----------------------------------------------
// 独立端口服务（0.2.5 起）下，空白页的主要来源在这里堵死：
//   1) 仍残留 app/ui/index.cgi → 说明是旧 CGI 半成品，入口模型不一致（必须已删）；
//   2) 入口不是 type=iframe / protocol=http / port=${wizard_port} / url="/" →
//      门户打不开应用自己的端口（或路径错），点开即空白；
//   3) 误留 gatewayPrefix/gatewaySocket → 三方应用网关注册不生效，请求被门户拦 invalid token；
//   4) 向导 wizard/install、wizard/config 缺失或不是合法 JSON → 安装/改端口收集不到 wizard_port。
(() => {
  const uiDir = path.join(packDir, "app", "ui");
  const cgiPath = path.join(uiDir, "index.cgi");
  const cfgPath = path.join(uiDir, "config");
  if (fs.existsSync(cgiPath)) {
    fail("仍存在 app/ui/index.cgi：0.2.5 起已改为独立端口服务，CGI 反代必须删除（git rm）。");
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch (e) {
    fail(`app/ui/config 不是合法 JSON：${e?.message ?? e}`);
  }
  const entries = Object.values(cfg?.[".url"] ?? {});
  if (entries.length === 0) fail("app/ui/config 的 .url 下没有任何入口");
  for (const e of entries) {
    if (e.gatewayPrefix || e.gatewaySocket) {
      fail(
        `入口 "${e.title}" 仍声明 gatewayPrefix/gatewaySocket：` +
          `三方应用的统一网关注册在真机上不生效（实测被门户拦在 invalid token），会导致空白页。`,
      );
    }
    if (e.type !== "iframe") fail(`入口 "${e.title}" 的 type="${e.type}"，独立端口门户嵌入必须为 iframe`);
    if (e.protocol !== "http") fail(`入口 "${e.title}" 的 protocol="${e.protocol}"，端口服务入口必须为 http`);
    if (e.port !== "${wizard_port}") {
      fail(`入口 "${e.title}" 的 port="${e.port}"，必须为 "\${wizard_port}"（安装/配置向导收集的端口）`);
    }
    if (e.url !== PORT_ENTRY_URL) {
      fail(`入口 "${e.title}" 的 url="${e.url}"，独立端口根路径部署必须为 "/"`);
    }
  }
  for (const wiz of ["install", "config"]) {
    const wp = path.join(packDir, "wizard", wiz);
    if (!fs.existsSync(wp)) fail(`缺少 wizard/${wiz}（独立端口需在安装/配置向导收集 wizard_port）`);
    try {
      const parsed = JSON.parse(fs.readFileSync(wp, "utf8"));
      const fields = JSON.stringify(parsed);
      if (!fields.includes("wizard_port")) fail(`wizard/${wiz} 未包含 wizard_port 字段`);
    } catch (e) {
      fail(`wizard/${wiz} 不是合法 JSON：${e?.message ?? e}`);
    }
  }
  log(`入口一致性自检通过（${entries.length} 个端口服务入口，port=\${wizard_port}，url=/，向导齐备，无 CGI/网关残留）`);
})();

// --- 5.6) 品牌图标一致性自检（旧图标白屏/错图闸门） --------------------------------
// 飞牛桌面读 ICON.PNG / ICON_256.PNG 与 app/ui/images/icon_{256,64}.png。四处必须与品牌单源
// branding/app-icon/png 逐字节一致，避免重打时又带回旧版图标（2026-10 真机曾见桌面显旧图标）。
(() => {
  const md5 = (p) => crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex");
  const pairs = [
    ["ICON.PNG", "icon-256.png"],
    ["ICON_256.PNG", "icon-256.png"],
    ["app/ui/images/icon_256.png", "icon-256.png"],
    ["app/ui/images/icon_64.png", "icon-64.png"],
  ];
  for (const [dst, brand] of pairs) {
    const dstPath = path.join(packDir, dst);
    const brandPath = path.join(brandPngDir, brand);
    if (!fs.existsSync(dstPath)) fail(`缺少飞牛图标 ${dst}`);
    if (!fs.existsSync(brandPath)) fail(`缺少品牌单源 ${brand}`);
    if (md5(dstPath) !== md5(brandPath)) {
      fail(`图标 ${dst} 与品牌单源 branding/app-icon/png/${brand} 不一致（md5 不同，疑似旧图标），请先同步再打包`);
    }
  }
  log("品牌图标一致性自检通过（4 处图标 == branding/app-icon/png）");
})();


// 原生模块架构自检：至少应存在 better-sqlite3 的 .node 与 prisma libquery engine。
function assertExists(globHint, predicate) {
  const found = predicate();
  if (!found) fail(`未找到期望的 ${globHint}（linux/${wantArch} 原生模块可能没装上）`);
  log(`找到 ${globHint}`);
}
// 注意（hoisted 后实测）：better-sqlite3 的原生二进制落在 <pkg>/prebuilds/<platform>-<arch>.node，
// 而 build/Release 可能只是个空目录（源码编译路径才会真产出）。因此自检必须【真的找到一个 .node 文件】，
// 不能只判 build/Release 目录存在——否则会出现"目录在、二进制不在"的假绿。
assertExists("better-sqlite3 原生 .node", () => {
  const bs3 = path.join(serverDir, "node_modules", "better-sqlite3");
  const pre = path.join(bs3, "prebuilds", `${process.platform}-${process.arch}.node`);
  if (fs.existsSync(pre)) return true;
  const rel = path.join(bs3, "build", "Release");
  return fs.existsSync(rel) && fs.readdirSync(rel).some((f) => f.endsWith(".node"));
});
// hoisted 布局断言：fpk 能否装上取决于它，必须在打包前就把关（真机 10234 的教训）。
(() => {
  const nm = path.join(serverDir, "node_modules");
  let links = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) links++;
      else if (e.isDirectory()) walk(full);
    }
  })(nm);
  if (links > 0) {
    fail(
      `node_modules 内仍有 ${links} 个符号链接（期望 --node-linker=hoisted 全实体化）；` +
        `飞牛应用中心对该布局设目录 ACL 会失败（code 10234 acl_get_file failed）。`,
    );
  }
  log(`hoisted 布局自检通过（node_modules 内符号链接 ${links} 个）`);
})();

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

// --- 5.9) 应用更新只读令牌：构建末段注入 + 强制还原（只动 packDir 副本，绝不回写仓库） -------
// 流程（设计稿 §8.2）：fnpack 直接吃 packDir，故在打包前【就地】把 cmd/install_callback 里的
// 占位符 __GX_UPDATE_TOKEN__ 替换成 env GX_READER_TOKEN（只读单仓令牌），fnpack 一结束（成功或
// 失败）立即把源模板逐字节还原。还原由 process.on(exit) 兜底，SIGINT/SIGTERM 先手动还原再退出，
// 确保真实令牌绝不残留在 deploy/fnos/gouxiangdb/cmd/install_callback 这个被 git 跟踪的源模板里。
// - 未设 GX_READER_TOKEN：替换为空串（该包不内置令牌，更新源未配置，属合法的离线/未启用形态）；
// - 只替换一次且断言占位符确实被消费；令牌不写进任何日志。
{
  const tplPath = path.join(packDir, "cmd", "install_callback");
  const PLACEHOLDER = "__GX_UPDATE_TOKEN__";
  const originalTpl = fs.readFileSync(tplPath, "utf8");
  const readerToken = process.env.GX_READER_TOKEN ?? "";
  let injected = false;
  const restoreTemplate = () => {
    if (!injected) return;
    try {
      fs.writeFileSync(tplPath, originalTpl);
    } catch {
      /* exit 兜底路径，已无法再处理 */
    }
    injected = false;
  };
  process.on("exit", restoreTemplate);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      restoreTemplate();
      process.exit(130);
    });
  }
  const before = fs.readFileSync(tplPath, "utf8");
  if (!before.includes(PLACEHOLDER)) fail("令牌注入前发现占位符缺失，中止（源模板可能已被污染）");
  if (!before.includes(`${PLACEHOLDER}\n`) && !before.endsWith(PLACEHOLDER)) {
    // 占位符必须独占 GX_UPDATE_TOKEN= 之后的值，避免误替换到别处。
  }
  fs.writeFileSync(tplPath, before.split(PLACEHOLDER).join(readerToken));
  injected = true;
  // 替换后立即断言：包内副本不得再残留占位符。
  if (fs.readFileSync(tplPath, "utf8").includes(PLACEHOLDER)) fail("令牌占位符替换未生效");
  if (readerToken) log(`已注入应用更新只读令牌（来源 GX_READER_TOKEN，长度 ${readerToken.length}，值不回显）`);
  else log("未设 GX_READER_TOKEN：本包不内置更新只读令牌（更新源保持未配置）");
  // 登记还原器：fnpack 成功返回后立即手动还原；run() 失败走 process.exit 时由 exit 钩子兜底。
  globalThis.__restoreUpdateTokenTemplate = restoreTemplate;
}

// --- 6) fnpack build ------------------------------------------------------------
// 坑（2026-09-18 飞牛真机实测）：fnpack 1.2.1 在【校验失败】时的行为是——
//   stdout 打印 "Verifying files... / Packing failed. Required file "cmd/install_init" is missing"
//   然后【以退出码 0 结束】。
// 所以 run() 的退出码检查在这里完全失效，脚本会继续打印"fpk 已生成"，
// 而磁盘上根本没有 .fpk —— 属于会误导发布决策的假绿。
// 修法：以【产物是否真的落在磁盘】为准，构建前后各扫一次 *.fpk 做差集。
log("fnpack build");
function listFpk() {
  const out = [];
  for (const dir of [packDir, repoRoot]) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".fpk")) out.push(path.join(dir, e.name));
    }
  }
  return out;
}
// 先清掉上一次的同名产物：否则新包【覆盖同名文件】，前后差集为空，会把"已产出"误判成"未产出"。
for (const stale of listFpk()) {
  fs.rmSync(stale, { force: true });
  log(`清理旧产物 ${stale}`);
}
run("fnpack", ["build", "--directory", packDir]);
// fnpack 已结束（成功路径）：立刻把源模板里的真实令牌还原回占位符，缩短明文驻留时间。
globalThis.__restoreUpdateTokenTemplate?.();
const fpkProduced = listFpk();
if (fpkProduced.length === 0) {
  fail(
    "fnpack build 未产出任何 .fpk（fnpack 校验失败时打印 Packing failed 但仍以 0 退出，" +
      "故此处以磁盘产物为准；请回看上方 fnpack 的 Verifying/Packing 输出定位缺失文件）。",
  );
}
for (const p of fpkProduced) {
  log(`产出 ${p}（${(fs.statSync(p).size / 1024 / 1024).toFixed(2)} MiB）`);
}
log(`完成：gouxiangdb ${version} ${arch} fpk 已生成。`);
log("安装测试：appcenter-cli install-fpk <name>.fpk 或应用中心手动安装。");
