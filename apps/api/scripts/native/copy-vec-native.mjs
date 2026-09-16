#!/usr/bin/env node
// apps/api/scripts/native/copy-vec-native.mjs
//
// M5/S2 原生供应链（§12）：把已安装的 sqlite-vec 平台子包内 vec0.<ext> 显式拷贝到
// 发布物白名单目录 <dest>/native/<triplet>/vec0.<ext>，与 esbuild 产物分离（原生二进制不打包进 bundle）。
//
// 为什么除 node_modules 外还要白名单：
//   - 发布物是白名单组装（package-release/build-fpk 纪律），不整目录带 node_modules 之外的散文件；
//   - 运行时 resolveVecPath 优先级 GX_VEC_EXT_PATH > <appDir>/native/<triplet> > node_modules，
//     白名单拷贝在 node_modules 解析被 pnpm 布局/裁剪影响时提供确定路径；
//   - 拷贝后用 `file` 做架构自检，防止把错误架构的 .so/.dylib 投到目标机。
//
// 架构语义：本脚本必须在【目标架构】环境运行（裸机构建机 / buildx 目标平台 / fpk linux 同构），
// 因此 triplet 直接取 process.platform/arch，不做交叉选择（交叉架构本就无法在此选取正确原生件）。
//
// 用法：node scripts/native/copy-vec-native.mjs --dest <dir> [--app-dir <dir>]
//   --dest      发布物应用根（含 dist/ 的目录）；vec0 落到 <dest>/native/<triplet>/。
//   --app-dir   解析已装 sqlite-vec 的 apps/api 目录（默认本脚本上两级）。
// 退出码：0 成功或 sqlite-vec 可选依赖缺失（打印 SKIP，不 fail——降级 fts-only 是合法姿态，H8/H6）；
//         找到文件但拷贝/架构自检失败 -> 非 0（发版门应拦截）。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultAppDir = path.resolve(here, "..", "..");

function parseArgs(argv) {
  const out = { dest: "", appDir: defaultAppDir };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dest") out.dest = argv[++i] ?? "";
    else if (a === "--app-dir") out.appDir = argv[++i] ?? "";
  }
  return out;
}

function describe(platform, arch) {
  if (platform === "win32") return { triplet: `win32-${arch}`, ext: "dll", supported: arch === "x64" };
  if (platform === "darwin") return { triplet: `darwin-${arch}`, ext: "dylib", supported: arch === "x64" || arch === "arm64" };
  return { triplet: `linux-${arch}`, ext: "so", supported: arch === "x64" || arch === "arm64" };
}

function resolveInstalledVec(appDir) {
  // 从 apps/api 视角 require sqlite-vec（pnpm 下 apps/api/node_modules/sqlite-vec 是软链）。
  const req = createRequire(path.join(appDir, "package.json"));
  let mod;
  try {
    mod = req("sqlite-vec");
  } catch {
    return { ok: false, reason: "sqlite-vec optional dependency not installed" };
  }
  if (typeof mod.getLoadablePath !== "function") {
    return { ok: false, reason: "sqlite-vec has no getLoadablePath()" };
  }
  let file;
  try {
    file = mod.getLoadablePath();
  } catch (err) {
    // 当前平台无子包（如 musl/不支持架构）：getLoadablePath 抛 unsupported platform。
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, file };
}

/** `file <vec0>` 输出架构自检；无法执行 file 时只告警不拦。 */
function archSelfCheck(src, triplet) {
  const r = spawnSync("file", [src], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) {
    console.warn(`[vec-native] file 自检跳过（file 不可用）：${src}`);
    return;
  }
  const out = r.stdout.toLowerCase();
  if (triplet.endsWith("arm64")) {
    if (!(out.includes("arm64") || out.includes("aarch64"))) {
      throw new Error(`架构自检失败：${triplet} 但 file 输出未见 arm64/aarch64 -> ${r.stdout.trim()}`);
    }
  } else if (triplet.endsWith("x64")) {
    if (!(out.includes("x86-64") || out.includes("x86_64"))) {
      throw new Error(`架构自检失败：${triplet} 但 file 输出未见 x86-64 -> ${r.stdout.trim()}`);
    }
  }
  console.log(`[vec-native] file 自检通过（${triplet}）：${r.stdout.trim()}`);
}

function main() {
  const { dest, appDir } = parseArgs(process.argv);
  if (!dest) {
    console.error("[vec-native] 用法：copy-vec-native.mjs --dest <发布物应用根> [--app-dir <apps/api>]");
    process.exit(2);
  }
  const info = describe(process.platform, process.arch);
  if (!info.supported) {
    // 不支持平台不阻断构建：该目标机本就纯 FTS（H6 无 musl/32 位）。
    console.warn(`[vec-native] SKIP：当前 ${info.triplet} 无预编译 vec0，发布物纯 FTS 服役。`);
    return;
  }
  const found = resolveInstalledVec(appDir);
  if (!found.ok) {
    console.warn(`[vec-native] SKIP：${found.reason}；发布物在该平台以 fts-only 降级服役（不阻断构建）。`);
    return;
  }
  const src = found.file;
  if (!fs.existsSync(src)) {
    console.error(`[vec-native] FAIL：解析到路径但文件不存在：${src}`);
    process.exit(1);
  }
  const destDir = path.join(dest, "native", info.triplet);
  const destFile = path.join(destDir, `vec0.${info.ext}`);
  fs.mkdirSync(destDir, { recursive: true, mode: 0o755 });
  fs.copyFileSync(src, destFile);
  fs.chmodSync(destDir, 0o755);
  fs.chmodSync(destFile, 0o644);
  archSelfCheck(destFile, info.triplet);
  console.log(`[vec-native] OK ${path.relative(process.cwd(), destFile)}（来源 ${path.basename(path.dirname(src))}）`);
}

main();
