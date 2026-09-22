// apps/api/scripts/build.mjs
// 生产构建：esbuild 扁平单文件 ESM dist/index.js。
// 为什么不用 tsc 直出（ADR-0011 候选）：
//   1) tsc 因 @gx/shared-types 的 path 引用把 rootDir 抬到 monorepo 根，
//      产物落在 dist/apps/api/src/index.js，与 start=node dist/index.js 不符；
//   2) @gx/shared-types 只发裸 TS、无 build，运行时 ERR_MODULE_NOT_FOUND；
//   3) tsc 会把 8 个 *.test.js 编进 dist。
// 策略：内化 workspace 源码（@gx/*），外置运行时/原生依赖（从 apps/api/node_modules 解析）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");
const repoRoot = path.resolve(apiRoot, "../..");

const rootPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
if (typeof rootPkg.version !== "string" || !rootPkg.version) {
  console.error("[build] 根 package.json 缺少 version，无法注入 GX_VERSION");
  process.exit(1);
}

const distDir = path.join(apiRoot, "dist");
const outFile = path.join(distDir, "index.js");
// M6/S6：stdio 第二入口 -> dist/mcp-stdio.js（C-5：随包投递的文件，不常驻、不占端口）。
const stdioOutFile = path.join(distDir, "mcp-stdio.js");
// M3-S11-A/AC-UPG-1：nav 对账第三入口 -> dist/nav-reconcile.js。
// 四个部署面在 prisma migrate deploy 后必须跑一次 --apply（迁移只给根节点 path），
// 故该脚本必须随生产 dist 投递，不能只以 tsx 源码形式存在。
const navReconcileOutFile = path.join(distDir, "nav-reconcile.js");
// 首次部署超级管理员初始化第四入口 -> dist/init-admin.js。
// 三套部署链路在 migrate deploy + nav-reconcile 之后、服务启动之前调 node dist/init-admin.js，
// 缺该产物即首次部署无法创建管理员，故必须与主服务同包投递。
const initAdminOutFile = path.join(distDir, "init-admin.js");

// 外置：运行时从发布包 node_modules 解析。
// better-sqlite3 含 .node 原生二进制，严禁打包；@prisma/client 自带 query engine。
// sqlite-vec 的 vec0 是运行时 loadExtension 的独立动态库（不进 bundle），发布物按
// scripts/native/copy-vec-native.mjs 显式拷到 native/<triplet>/，故一并外置（M5/S2 §12）。
const external = [
  "@hono/node-server",
  "@prisma/client",
  "hono",
  "jose",
  "zod",
  "bcryptjs",
  "better-sqlite3",
  "sqlite-vec",
  // M6/S2：MCP SDK（纯 JS，含 zod/v4 子路径）；随发布包 node_modules 解析。
  "@modelcontextprotocol/sdk",
  // 协同（批次 F）：ws 是 CJS 包，内化进 ESM 单文件产物后会在运行时执行
  // require("events")，ESM 下抛 "Dynamic require of \"events\" is not supported"
  // —— 真机 `node dist/index.js` 启动即崩，systemd 表现为 status=1/FAILURE。
  // 本机 `pnpm build` 只做打包不执行产物，故这个坑只有真机启动才暴露。
  "ws",
];

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

await esbuild.build({
  // M6/S6：双入口 —— index（HTTP 服务） + mcp-stdio（stdio 命令行入口）。
  // M3-S11-A：第三入口 nav-reconcile（migrate deploy 后 path 重算，部署链路调用）。
  // 多入口须用 outdir + 逐入口 out 名（用 outfile 会报错）；
  // 产物 dist/index.js + dist/mcp-stdio.js + dist/nav-reconcile.js。
  entryPoints: [
    { in: path.join(apiRoot, "src/index.ts"), out: "index" },
    { in: path.join(apiRoot, "src/mcp/stdio.ts"), out: "mcp-stdio" },
    { in: path.join(apiRoot, "scripts/nav/reconcile-nav.ts"), out: "nav-reconcile" },
    // 首次部署建首个超级管理员（迁移后一次，幂等）。
    { in: path.join(apiRoot, "scripts/init-admin.ts"), out: "init-admin" },
  ],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outdir: distDir,
  sourcemap: false,
  keepNames: true,
  // 不用 packages:"external"——那会把 workspace 的 @gx/* 也外置；
  // 这里只外置下列运行时/原生依赖，@gx/shared-types 经 tsconfig paths 内化。
  external,
  logLevel: "info",
  define: {
    "process.env.GX_VERSION": JSON.stringify(rootPkg.version),
  },
});

if (!fs.existsSync(outFile)) {
  console.error("[build] 构建结束但 dist/index.js 不存在");
  process.exit(1);
}
if (!fs.existsSync(stdioOutFile)) {
  console.error("[build] 构建结束但 dist/mcp-stdio.js 不存在（M6/S6 第二入口产物缺失）");
  process.exit(1);
}
if (!fs.existsSync(navReconcileOutFile)) {
  console.error("[build] 构建结束但 dist/nav-reconcile.js 不存在（M3-S11-A 第三入口产物缺失）");
  process.exit(1);
}
if (!fs.existsSync(initAdminOutFile)) {
  console.error("[build] 构建结束但 dist/init-admin.js 不存在（首次部署初始化第四入口产物缺失）");
  process.exit(1);
}

const stat = fs.statSync(outFile);
const stdioStat = fs.statSync(stdioOutFile);
const navReconcileStat = fs.statSync(navReconcileOutFile);
const initAdminStat = fs.statSync(initAdminOutFile);
console.log(
  `[build] OK dist/index.js ${(stat.size / 1024).toFixed(1)} KiB, dist/mcp-stdio.js ${(stdioStat.size / 1024).toFixed(1)} KiB, dist/nav-reconcile.js ${(navReconcileStat.size / 1024).toFixed(1)} KiB, dist/init-admin.js ${(initAdminStat.size / 1024).toFixed(1)} KiB, GX_VERSION=${rootPkg.version}`,
);
