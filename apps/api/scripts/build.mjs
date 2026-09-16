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
];

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(apiRoot, "src/index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: outFile,
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

const stat = fs.statSync(outFile);
console.log(
  `[build] OK dist/index.js ${(stat.size / 1024).toFixed(1)} KiB, GX_VERSION=${rootPkg.version}`,
);
