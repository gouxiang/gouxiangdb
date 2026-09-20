// scripts/sync-help-center.mjs
// 帮助中心「分片真源 → 生成物」的同步脚本（零依赖，纯 node:fs）。
//
// 真源（人工编辑的唯一位置）：docs/help-center/_parts/*.md
//   - 合并顺序 = 文件名自然序，用数字前缀控制：00-index.md / 10-database.md / 20-platform.md …
//   - 新增主题只要按数字前缀命名即可，脚本不用改。
//   - 只合并匹配 /^\d+.*\.md$/ 的文件名；其余（如 bugfix-candidates.md 这类 bug 登记）
//     一律跳过并 console 提示，绝不能并进正文。
// 生成物（都进 .gitignore，改内容请改 _parts/）：
//   docs/help-center/HELP-CENTER.md                       —— 分片按序拼接（片间插 `---`）
//   apps/web/src/features/help/generated/help-center.md   —— 前端 ?raw 导入的副本
//   apps/web/public/help-assets/*                          —— 配图的运行时静态副本
//
// ============================================================================
// 注意（清理脚本硬要求（用户明确要求，不得删除本注释）：
//    docs/help-center/assets/ 是**帮助中心截图专用资源目录**（含 .gitkeep），
//    apps/web/public/help-assets/ 是它的运行时副本（本脚本每次重建）。
//    任何「清空 docs 下图片」「清理 public 目录」「删除未引用资源」类的脚本
//    都必须显式排除这两个路径，否则帮助中心配图会整批消失且无法从真源恢复。
//    同理：docs/help-center/_parts/ 是正文真源，不许当临时文件清理。
// ============================================================================

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SRC_DIR = join(ROOT, "docs", "help-center");
/** 正文分片真源目录（人工编辑的唯一位置） */
const PARTS_DIR = join(SRC_DIR, "_parts");
/** 参与合并的文件名规则：数字前缀开头（00-/10-/20-…），其余一律跳过 */
const PART_FILE_RE = /^\d+.*\.md$/;
/** 生成物 1：拼接后的完整文档（供人阅读/导出，前端不直接用它） */
const OUT_MERGED = join(SRC_DIR, "HELP-CENTER.md");
/** 生成物 2：前端 ?raw 导入的副本 */
const OUT_WEB_MD = join(ROOT, "apps", "web", "src", "features", "help", "generated", "help-center.md");
/**
 * 生成物 3：配图运行时副本（vite publicDir 下）。
 *
 * H-01（2026-09-20 帮助中心验收）：目录名**不能叫 help**。public/ 下的目录会原样落到
 * 部署根，`public/help/assets/` → 部署根下出现真实目录 `help/`，而 `/help` 同时又是
 * 帮助中心的 SPA 路由——静态服务在 SPA 回退**之前**先按真实目录处理：
 * nginx 实测 `/help` → 301 `/help/` → 403（autoindex off），随机路径反而 200 回退
 * index.html。故改名 /help-assets/，让路由与静态目录彻底不重名（见 help-html.ts）。
 */
const OUT_ASSETS = join(ROOT, "apps", "web", "public", "help-assets");
const SRC_ASSETS = join(SRC_DIR, "assets");

/** 分片之间的分隔：只插在片与片之间，不改分片内部（渲染为 <hr/>） */
const PART_SEPARATOR = "\n\n---\n\n";

/**
 * 列出参与合并的分片（自然序：2 < 10，不按字典序）。
 * 一个都没有 → 抛错：宁可让 dev/build 失败，也不许静默产一份空文档。
 */
function listParts() {
  let names = [];
  try {
    names = readdirSync(PARTS_DIR).filter((n) => n.endsWith(".md"));
  } catch {
    throw new Error(`正文分片目录不可读：${PARTS_DIR}（真源为 docs/help-center/_parts/*.md）`);
  }
  const accepted = names
    .filter((n) => PART_FILE_RE.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const skipped = names.filter((n) => !PART_FILE_RE.test(n));

  if (accepted.length === 0) {
    throw new Error(
      `没有找到任何正文分片：${PARTS_DIR} 下需至少一个 ${PART_FILE_RE} 形式的文件（如 00-index.md）`,
    );
  }
  for (const n of skipped) {
    console.log(`[sync-help-center] 跳过（非数字前缀，不属正文）：_parts/${n}`);
  }
  console.log(`[sync-help-center] 合并顺序（${accepted.length} 片）：${accepted.join(" → ")}`);
  return accepted;
}

/**
 * 读分片正文。除第一片外，顶层 H1（`# `）降级为 H2 并警告：
 * 文档只应有一个 H1，多个 H1 会让目录里出现并列的顶层章节，顺序也被打乱。
 */
function readPart(name, isFirst) {
  const raw = readFileSync(join(PARTS_DIR, name), "utf8").replace(/\r\n/g, "\n").trim();
  if (isFirst) return raw;
  let demoted = 0;
  const lines = raw.split("\n").map((line) => {
    if (!/^#\s+/.test(line)) return line;
    demoted += 1;
    return line.replace(/^#\s+/, "## ");
  });
  if (demoted > 0) {
    console.log(`[sync-help-center] 警告：_parts/${name} 含 ${demoted} 个顶层 H1，已降级为 H2（文档只允许首个分片有 H1）`);
  }
  return lines.join("\n");
}

function mergeParts(names) {
  return names.map((n, i) => readPart(n, i === 0)).join(PART_SEPARATOR) + "\n";
}

/**
 * 截图同步：只做覆盖式复制，不做清空。
 *
 * 为什么不先删目标目录：构建机/沙箱上 `rmSync` 目录会走批量删除与回收站动作，
 * 实测会失败（甚至中断整次构建）；而陈旧副本最坏只是多占一点空间，不会让正文 404。
 * 真源里删掉的图改为「提示」——由人工确认后清理，避免误删。
 */
function syncAssets() {
  mkdirSync(OUT_ASSETS, { recursive: true });
  let names = [];
  try {
    names = readdirSync(SRC_ASSETS);
  } catch {
    mkdirSync(SRC_ASSETS, { recursive: true });
    return 0;
  }
  const keep = new Set();
  let n = 0;
  for (const name of names) {
    if (name === ".gitkeep") continue;
    const from = join(SRC_ASSETS, name);
    if (!statSync(from).isFile()) continue;
    copyFileSync(from, join(OUT_ASSETS, name));
    keep.add(name);
    n += 1;
  }
  const stale = readdirSync(OUT_ASSETS).filter((f) => !keep.has(f));
  if (stale.length > 0) {
    console.log(
      `[sync-help-center] 提示：${OUT_ASSETS} 下 ${stale.length} 个文件在真源已不存在（不自动删除）：${stale.join(", ")}`,
    );
  }
  return n;
}

function main() {
  const names = listParts();
  const merged = mergeParts(names);
  writeFileSync(OUT_MERGED, merged);

  mkdirSync(dirname(OUT_WEB_MD), { recursive: true });
  writeFileSync(OUT_WEB_MD, merged);

  const images = syncAssets();
  const bytes = Buffer.byteLength(merged, "utf8");
  if (bytes === 0) throw new Error("拼接结果为空（不应发生）：请检查 _parts/ 分片内容");
  console.log(
    `[sync-help-center] ${names.length} 片 → ${OUT_MERGED}（${bytes} 字节）；` +
      `副本 → ${OUT_WEB_MD}；截图 ${images} 个 → ${OUT_ASSETS}`,
  );
}

main();
