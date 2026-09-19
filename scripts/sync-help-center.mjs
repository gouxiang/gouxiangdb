// scripts/sync-help-center.mjs
// 帮助中心「单一真源 → 前端可用产物」的同步脚本（零依赖，纯 node:fs）。
//
// 管线（与页面侧一一对应）：
//   docs/help-center/HELP-CENTER.md  ──复制──▶ apps/web/src/features/help/generated/help-center.md
//   docs/help-center/assets/*        ──复制──▶ apps/web/public/help/assets/*
// 页面用 `import md from "./generated/help-center.md?raw"` 取文本，图片则经
// /help/assets/ 由静态服务直接提供（public/ 目录由 vite 原样拷进 dist）。
//
// 产物不入库（见 .gitignore）：真源在 docs/，generated/ 与 public/help/ 都是派生物。
//
// 注意（清理脚本必读）：docs/help-center/assets/ 是**帮助中心截图专用资源目录**，
//    apps/web/public/help/assets/ 是它的运行时副本。任何「清空 docs 图片 /
//    清理 public 目录」的脚本都必须排除这两个路径，否则帮助中心配图会整批消失。

import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 真源目录（唯一需要人工编辑的地方） */
const SRC_DIR = join(ROOT, "docs", "help-center");
const SRC_MD = join(SRC_DIR, "HELP-CENTER.md");
/** 截图专用资源目录（清理脚本必须排除） */
const SRC_ASSETS = join(SRC_DIR, "assets");

const WEB = join(ROOT, "apps", "web");
/** 前端可 import 的 md 副本（?raw 文本导入） */
const OUT_MD = join(WEB, "src", "features", "help", "generated", "help-center.md");
/** 运行时静态图片目录（vite publicDir 下，部署基路径无关） */
const OUT_ASSETS = join(WEB, "public", "help", "assets");

function copyOrThrow(from, to, what) {
  try {
    copyFileSync(from, to);
  } catch (err) {
    throw new Error(`帮助中心同步失败（${what}）：${from} → ${to}\n  ${err.message}`);
  }
}

/** 目录整体重建：保证「真源删掉的图」在产物里也消失，不留幽灵文件。 */
function syncAssets() {
  rmSync(OUT_ASSETS, { recursive: true, force: true });
  mkdirSync(OUT_ASSETS, { recursive: true });

  let names = [];
  try {
    names = readdirSync(SRC_ASSETS);
  } catch {
    // 资源目录尚未建（首次同步）：正文里本来也就没有配图，空目录即可
    mkdirSync(SRC_ASSETS, { recursive: true });
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (name === ".gitkeep") continue;
    const from = join(SRC_ASSETS, name);
    if (!statSync(from).isFile()) continue;
    copyOrThrow(from, join(OUT_ASSETS, name), "截图资源");
    n += 1;
  }
  return n;
}

function main() {
  if (!statSync(SRC_MD, { throwIfNoEntry: false })) {
    throw new Error(`帮助中心真源缺失：${SRC_MD}`);
  }
  mkdirSync(dirname(OUT_MD), { recursive: true });
  copyOrThrow(SRC_MD, OUT_MD, "正文真源");
  const images = syncAssets();
  console.log(`[sync-help-center] ${SRC_MD} → ${OUT_MD}；截图 ${images} 个 → ${OUT_ASSETS}`);
}

main();
