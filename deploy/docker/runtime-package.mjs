#!/usr/bin/env node
// deploy/docker/runtime-package.mjs — 生成 runner 阶段精简运行时 package.json。
//
// 从 Dockerfile 内联 `node -e '...'` 抽出：长多行 JS 经 /bin/sh -c 单引号续行包裹时，
// 在 Debian dash 下会被错误解析（SyntaxError: Unexpected token '-'），独立脚本可彻底
// 规避 shell 引号/续行问题，且与 deploy/bin/package-release.mjs 的精简口径保持一致：
//   - 去掉 esbuild 已内化的 @gx/* workspace 依赖；
//   - 把 prisma CLI（源工程在 devDeps）提入 deps；
//   - sqlite-vec 作为【可选】依赖带入（平台缺子包时不阻断，运行时降级 fts-only）。
//
// 用法：node deploy/docker/runtime-package.mjs <output-path>
// 在 builder 阶段 /app 下执行，默认输出 /app/runtime-package.json。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outPath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(repoRoot, "runtime-package.json");

const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const apiPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "apps", "api", "package.json"), "utf8"),
);

const deps = { ...(apiPkg.dependencies ?? {}) };
for (const key of Object.keys(deps)) {
  if (key.startsWith("@gx/")) delete deps[key];
}
deps.prisma = apiPkg.devDependencies?.prisma ?? "^5.22.0";

const optional = {};
if (apiPkg.optionalDependencies?.["sqlite-vec"]) {
  optional["sqlite-vec"] = apiPkg.optionalDependencies["sqlite-vec"];
}

const runtimePkg = {
  name: "gouxiangdb-api-runtime",
  version: rootPkg.version || "0.0.0",
  private: true,
  type: "module",
  packageManager: rootPkg.packageManager ?? "pnpm@9.0.0",
  dependencies: deps,
  ...(Object.keys(optional).length ? { optionalDependencies: optional } : {}),
};

fs.writeFileSync(outPath, `${JSON.stringify(runtimePkg, null, 2)}\n`);
console.log(`[runtime-package] 已生成 ${path.relative(repoRoot, outPath)}`);
