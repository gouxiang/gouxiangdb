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
 * id 与 renderMarkdown 内建的 `h-${slugify(text)}` 完全同算法，保证 TOC 与正文对得上。
 */
export function extractHelpHeadings(md: string): HelpHeading[] {
  const out: HelpHeading[] = [];
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
    out.push({ id: `h-${slugify(text)}`, level: m[1]!.length, text });
  }
  return out;
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
