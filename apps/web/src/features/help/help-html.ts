// apps/web/src/features/help/help-html.ts
// 帮助中心「wiki md 文本 → 可渲染 HTML」的纯函数层（不碰 DOM，便于 node 环境单测直接覆盖）。
//
// 管线：
//   md → stripHtmlComments → rewriteWikiLinks（Gitea 双链 → 内部切页链接）
//      → renderMarkdown(@gx/blocks) → sanitizeHtml → 标题锚点回注
//
// 图片路径不再由前端改写：后端 /api/help/wiki 已把 images/... 改写成同源绝对路径
// （/api/help/asset?path=...），前端再改会双重拼接。
//
// 为什么锚点要「回注」：sanitizeHtml 只放行有限属性（不含 id / class），renderMarkdown
// 产出的 data-heading-id 会被剥掉；百科单页内部仍可能有多个章节，故在消毒之后
// 按标题出现顺序重新注入 id（顺序与 extractHelpHeadings 严格一致，不会错位）。

import { renderMarkdown, slugify } from "@gx/blocks";
import { sanitizeHtml } from "../../lib/sanitize-html";

export interface HelpHeading {
  /** 锚点 id：与 renderMarkdown 的 `h-${slugify(text)}` 同一算法 */
  id: string;
  level: number;
  text: string;
}

/** 百科页面目录项（契约真源：后端 GET /api/help/wiki 的 pages 元素）。 */
export interface WikiPageEntry {
  title: string;
  href: string;
}

const HEADING_LINE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
/** HTML 注释：`<!-- … -->`（可跨行）。作者用它标注「待补截图」，不该出现在读者眼里。 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** Gitea 双链 [[页面名]] / [[页面名|别名]]；页面名与别名内部不允许再出现方括号。 */
const WIKI_LINK = /\[\[([^[\]|]+)(?:\|([^[\]]+))?\]\]/g;

/** 内部切页链接的 hash 前缀；事件委托靠 a[href^="#help-page/"] 拦截，消毒器放行 # 开头 href。 */
export const WIKI_PAGE_HASH_PREFIX = "#help-page/";

/**
 * 剥掉 md 里的 HTML 注释后再渲染。
 *
 * 百科作者也可能用 `<!-- IMG: 待补 —— … -->` 标注待补配图，markdown 渲染器把整行当文本
 * 处理并转义成 `&lt;!-- … --&gt;`，注释就以正文形态泄漏在页面上。注释对读者无信息量，先行剔除。
 *
 * 保护围栏代码块：``` 与 ~~~ 内部的 `<!-- … -->` 是**示例**（讲该怎么写的正文），不能删。
 */
export function stripHtmlComments(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let plain: string[] = [];
  let fence: string[] | null = null;
  let fenceMark = "";
  const flushPlain = () => {
    if (!plain.length) return;
    // 整块（而非逐行）替换：注释可能跨多行，逐行扫描会在首行漏掉开头
    out.push(plain.join("\n").replace(HTML_COMMENT, ""));
    plain = [];
  };
  for (const line of lines) {
    const mark = FENCE_LINE.exec(line)?.[1];
    if (fence) {
      fence.push(line);
      if (mark && mark[0] === fenceMark[0] && mark.length >= fenceMark.length) {
        out.push(fence.join("\n"));
        fence = null;
        fenceMark = "";
      }
      continue;
    }
    if (mark) {
      flushPlain();
      fence = [line];
      fenceMark = mark;
      continue;
    }
    plain.push(line);
  }
  flushPlain();
  // 未闭合的围栏（正文里少写收尾 ```）：原样吐出，不吞用户的示例
  if (fence) out.push(fence.join("\n"));
  return out.join("\n");
}

/**
 * 把一行内的行内代码段（`code` / `` `code` `` 等长反引号串）替换为占位符，返回占位后的行
 * 与代码段数组。CommonMark 要求开闭反引号串等长，这里按同一规则配对；找不到配对的反引号
 * 按普通字符放过（不把半行正文误判成代码）。
 */
function stashInlineCode(line: string): { masked: string; spans: string[] } {
  const spans: string[] = [];
  let masked = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      masked += line[i];
      i += 1;
      continue;
    }
    let j = i;
    while (j < line.length && line[j] === "`") j += 1;
    const runLen = j - i;
    // 寻找等长闭合反引号串
    let k = j;
    let closeEnd = -1;
    while (k < line.length) {
      if (line[k] !== "`") {
        k += 1;
        continue;
      }
      let l = k;
      while (l < line.length && line[l] === "`") l += 1;
      if (l - k === runLen) {
        closeEnd = l;
        break;
      }
      k = l;
    }
    if (closeEnd < 0) {
      masked += line[i];
      i += 1;
      continue;
    }
    spans.push(line.slice(i, closeEnd));
    // 私用区码位做占位：绝不会出现在正常百科正文里，也不触发 no-control-regex
    masked += `\uE000${spans.length - 1}\uE000`;
    i = closeEnd;
  }
  return { masked, spans };
}

/** 页面名 → 切页 hash：encodeURIComponent 之外再转义括号，避免括号提前结束 markdown 链接。 */
function encodeWikiPage(page: string): string {
  return encodeURIComponent(page).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** 转换一行内（围栏外）的双链；行内代码段先摘出，转换后还原。 */
function rewriteWikiLinksLine(line: string): string {
  const { masked, spans } = stashInlineCode(line);
  const converted = masked.replace(WIKI_LINK, (whole, rawPage: string, rawAlias?: string) => {
    const page = rawPage.trim();
    if (!page) return whole;
    const label = (rawAlias ?? page).trim() || page;
    return `[${label}](${WIKI_PAGE_HASH_PREFIX}${encodeWikiPage(page)})`;
  });
  return converted.replace(/\uE000(\d+)\uE000/g, (m, idx: string) => spans[Number(idx)] ?? m);
}

/**
 * 把 Gitea wiki 双链转换成应用内切页 markdown 链接：
 *   [[页面名]]        → [页面名](#help-page/<encodeURIComponent(页面名)>)
 *   [[页面名|别名]]   → [别名](#help-page/<encodeURIComponent(页面名)>)
 *
 * 必须跳过：
 *   - 围栏代码块（``` 与 ~~~，含开栏行的 info string 与未闭合围栏）；
 *   - 行内代码 `code`（代码里出现的 [[ ]] 是讲解用的示例，不能转）。
 */
export function rewriteWikiLinks(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  // 当前围栏标记字符（` 或 ~）与开栏反引号/波浪线数量；null = 不在围栏内
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  return lines
    .map((line) => {
      const mark = FENCE_LINE.exec(line)?.[1];
      if (fenceChar) {
        if (mark && mark[0] === fenceChar && mark.length >= fenceLen) {
          fenceChar = null;
          fenceLen = 0;
        }
        return line;
      }
      if (mark) {
        fenceChar = mark[0] as "`" | "~";
        fenceLen = mark.length;
        return line;
      }
      return rewriteWikiLinksLine(line);
    })
    .join("\n");
}

/**
 * 抽取标题生成锚点列表（跳过围栏代码块内的 `#`，那不是标题而是示例语法）。
 * 入参应为 stripHtmlComments + rewriteWikiLinks 之后的 md（与送进 renderMarkdown 的同一份），
 * 保证锚点文本与正文标题同序同数。
 *
 * 同名标题（如两处 `## 全局搜索`）会算出同一个 slug → 同一个锚点 id。故对重复 slug
 * 追加 `-2` / `-3` 序号，文本与层级保持不变。
 */
export function extractHelpHeadings(md: string): HelpHeading[] {
  const out: HelpHeading[] = [];
  const seen = new Map<string, number>();
  let fenceChar: "`" | "~" | null = null;
  let fenceLen = 0;
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const mark = FENCE_LINE.exec(raw)?.[1];
    if (mark && (!fenceChar || (mark[0] === fenceChar && mark.length >= fenceLen))) {
      if (!fenceChar) {
        fenceChar = mark[0] as "`" | "~";
        fenceLen = mark.length;
      } else {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    if (fenceChar) continue;
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

/** 目录检索：按页面标题子串过滤（中文直接 includes，不分词）；空串返回全量副本。 */
export function filterHelpPages(pages: readonly WikiPageEntry[], query: string): WikiPageEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...pages];
  return pages.filter((p) => p.title.toLowerCase().includes(q));
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
 * 该分支只发生在 node 单测：此时内容来自后端代理的百科正文（非本应用用户输入），
 * 且 renderMarkdown 已整体转义，跳过消毒不影响测试对纯函数管线的断言；浏览器侧永远走消毒分支。
 */
function sanitizeWhenDom(html: string): string {
  if (typeof document === "undefined") return html;
  return sanitizeHtml(html);
}

/**
 * 组装最终 HTML：wiki md → { html, headings }。
 * 流程：剥 HTML 注释 → 双链转内部切页链接 → renderMarkdown → 消毒 → 锚点回注。
 * 图片路径保持后端给的同源绝对路径原样，不做任何前端改写。
 */
export function buildHelpHtml(md: string): { html: string; headings: HelpHeading[] } {
  const clean = rewriteWikiLinks(stripHtmlComments(md));
  const headings = extractHelpHeadings(clean);
  const rendered = renderMarkdown(clean);
  return { html: attachHeadingIds(sanitizeWhenDom(rendered), headings), headings };
}
