// apps/web/src/features/help/help-html.ts
// 帮助中心「md 文本 → 可渲染 HTML」的纯函数层（不碰 DOM，便于 node 环境单测直接覆盖）。
//
// 管线（与 scripts/sync-help-center.mjs 的同步方向一一对应）：
//   md → renderMarkdown(@gx/blocks) → 图片相对路径映射 → sanitizeHtml → 标题锚点回注
//
// 为什么锚点要「回注」：sanitizeHtml 只放行有限属性（不含 id / class），renderMarkdown
// 产出的 data-heading-id 会被剥掉；目录点击需要 id 才能 scrollIntoView，故在消毒之后
// 按标题出现顺序重新注入 id（顺序与 extractHelpHeadings 严格一致，不会错位）。

import { renderMarkdown, slugify } from "@gx/blocks";
import { sanitizeHtml } from "../../lib/sanitize-html";
import { withBase } from "../../lib/base";

export interface HelpHeading {
  /** 锚点 id：与 renderMarkdown 的 `h-${slugify(text)}` 同一算法 */
  id: string;
  level: number;
  text: string;
}

/** 静态服务路径：public/help/assets/ → 部署后 /help/assets/（再挂部署 base）。 */
export const HELP_ASSET_PATH = "/help/assets/";

const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_LINE = /^\s*(```|~~~)/;

/**
 * 抽取标题生成目录（跳过围栏代码块内的 `#`，那不是标题而是示例语法）。
 *
 * H-04（2026-09-20 帮助中心验收）：合并文档中同名标题（如两处 `## 全局搜索`）会算出同一个
 * slug → 同一个锚点 id。后果是（a）第二个永远跳不过去、（b）目录 React key 重复导致过滤后
 * 残留无关项、（c）滚动高亮串台。故在生成 id 时对重复 slug 追加 `-2` / `-3` 序号，
 * 文本与层级保持不变（读者看到的仍是两个同名章节）。
 */
export function extractHelpHeadings(md: string): HelpHeading[] {
  const out: HelpHeading[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    if (FENCE_LINE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING_LINE.exec(raw);
    if (!m) continue;
    const text = m[2]!;
    const base = `h-${slugify(text)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ id: n === 1 ? base : `${base}-${n}`, level: m[1]!.length, text });
  }
  return out;
}

/** 目录检索：按关键词过滤标题，命中项全量返回（id 唯一，过滤后不会残留无关项）。 */
export function filterHelpHeadings(
  headings: readonly HelpHeading[],
  query: string,
): HelpHeading[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...headings];
  return headings.filter((h) => h.text.toLowerCase().includes(q));
}

/**
 * 把正文里的相对配图路径映射成部署基路径下的静态路径。
 *
 * 只认 `src="assets/` 这一种形态（真源约定的配图写法），其余 URL（http(s)、/ 绝对路径、
 * data:）原样放过，不猜、不改写。base 由调用方注入（部署基路径），
 * 因此子路径部署（飞牛 fnOS 网关）与根部署都不会写死成 "/"。
 */
export function mapHelpAssetSrc(html: string, base: string): string {
  const prefix = withBase(base, HELP_ASSET_PATH);
  return html.replace(/src="assets\//g, `src="${prefix}`);
}

/**
 * 消毒后按标题顺序回注锚点 id。
 * headings 必须与 html 内标题**同序同数**（都由同一份 md 推出）；
 * 数量不一致时（md 被改动导致的极端情况）只对匹配到的前 n 个注入，不越界。
 */
export function attachHeadingIds(html: string, headings: readonly HelpHeading[]): string {
  let i = 0;
  return html.replace(/<h([1-6])([^>]*)>/g, (_m, level: string, attrs: string) => {
    const h = headings[i];
    if (!h) return `<h${level}${attrs}>`;
    i += 1;
    return `<h${level} id="${h.id}"${attrs}>`;
  });
}

/**
 * sanitizeHtml 走 DOM（template 解析），node/SSR 下没有 document。
 * 该分支只发生在服务端渲染与 node 单测：此时内容来自**仓库内真源 md**（非用户输入），
 * 且 renderMarkdown 已整体转义，跳过消毒不引入注入面；浏览器侧永远走消毒分支。
 */
function sanitizeWhenDom(html: string): string {
  if (typeof document === "undefined") return html;
  return sanitizeHtml(html);
}

/**
 * 组装最终 HTML：真源 md + 部署 base → { html, headings }。
 * sanitizeHtml 是纵深防御（md 侧已转义，这里再挡一次脚本与事件属性）。
 */
export function buildHelpHtml(md: string, base: string): { html: string; headings: HelpHeading[] } {
  const headings = extractHelpHeadings(md);
  const rendered = mapHelpAssetSrc(renderMarkdown(md), base);
  return { html: attachHeadingIds(sanitizeWhenDom(rendered), headings), headings };
}
