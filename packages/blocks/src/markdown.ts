// apps/web/src/features/kb/markdown.ts
// 零依赖轻量 Markdown 渲染器（类 Obsidian 预览所需子集）：
// 标题 / 粗体斜体删除行 / 行内代码 / 代码块 / 引用 / 有序无序列表 / 任务列表 / 链接 / 图片 / 表格 / 分隔线 / 换行。
// 输出已转义的 HTML 字符串，可安全 innerHTML 渲染（用户自有内容，仍统一转义防注入）。

import { isSafeUrl, sanitizeInlineStyle, parseTableSpans, tableOccupancy, stripSpanPrefix } from "./blocks";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 行内：粗体、斜体、删除线、行内代码、链接、图片、加粗符号 */
function inline(text: string): string {
  // 先抽取行内代码与链接占位，避免内部再被其它规则处理
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    placeholders.push(html);
    return `\u0000${placeholders.length - 1}\u0000`;
  };

  let s = text;
  // 图片 ![alt](url)（危险协议降级为纯文本）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) =>
    isSafeUrl(url)
      ? stash(`<img alt="${escapeHtml(alt)}" src="${escapeHtml(url)}" class="md-img" />`)
      : stash(escapeHtml(`![${alt}](${url})`)));
  // 链接 [text](url)——内部路由链接（/kb、/base 开头）走 SPA 跳转，外部链接新窗口；
  // 危险协议（javascript: 等）降级为纯文本，防存储型 XSS。
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, url) => {
    const u = url as string;
    if (!isSafeUrl(u)) return stash(escapeHtml(`[${t}](${u})`));
    const internal = /^\/(kb|base)\//.test(u);
    const attrs = internal
      ? `href="${escapeHtml(u)}" class="md-link md-link-internal" data-internal="1"`
      : `href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" class="md-link"`;
    return stash(`<a ${attrs}>${inlineRaw(t)}</a>`);
  });
  // 行内代码 `code`
  s = s.replace(/`([^`]+)`/g, (_m, code) => stash(`<code class="md-code-inline">${escapeHtml(code)}</code>`));
  // 行内公式 $...$
  s = s.replace(/\$([^$\n]+)\$/g, (_m, f) =>
    stash(`<span class="md-math-inline">${escapeHtml(f)}</span>`));
  // 行内颜色/背景色 span（WysiwygEditor 右键菜单 / htmlToInlineMd 产物）：
  // 开/闭标签各自 stash、内容留在原地——内容继续走下方 escapeHtml + 粗斜删等处理，
  // 因此 span 内的 **粗体** / ==高亮== 等语法正常渲染；
  // 栈配对支持嵌套（连续应用文字色+背景色产生嵌套 span）。
  // 非法 style（不在白名单）只丢标签、内容降级为纯文本，防 CSS 注入。
  {
    const openStack: boolean[] = [];
    s = s.replace(/<span\s+style="([^"]*)"\s*>/g, (_m, style) => {
      const safe = sanitizeInlineStyle(style);
      openStack.push(!!safe);
      return stash(safe ? `<span style="${safe}">` : "");
    });
    s = s.replace(/<\/span>/g, () => {
      const paired = openStack.pop() ?? false;
      return stash(paired ? "</span>" : "");
    });
  }

  s = escapeHtml(s);
  // 高亮 ==x==
  s = s.replace(/==([^=\n]+)==/g, '<mark class="md-mark">$1</mark>');
  // 粗体 **x** / __x__
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // 删除线 ~~x~~
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // 斜体 *x* / _x_
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/(^|[^*])_([^_\n]+)_/g, "$1<em>$2</em>");
  // 上标 ^x^
  s = s.replace(/\^([^^\n]+)\^/g, "<sup>$1</sup>");
  // 下标 ~x~（单波浪）
  s = s.replace(/(^|[^~])~([^~\n]+)~([^~]|$)/g, "$1<sub>$2</sub>$3");

  // 还原占位
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => placeholders[Number(i)] ?? "");
  return s;
}

/** 供链接文字等嵌套场景的行内（避免循环占位，直接简单处理） */
function inlineRaw(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code class="md-code-inline">$1</code>');
}

/* ---------------- 富文本组件（Markdown 兼容 HTML 扩展） ---------------- */
function attrOf(tag: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag);
  return m ? m[1]! : "";
}
const VIDEO_LINE = /^<video\b[^>]*>\s*(?:<\/video>)?\s*$/i;
const AUDIO_LINE = /^<audio\b[^>]*>\s*(?:<\/audio>)?\s*$/i;
const PDF_LINE = /^<iframe\b[^>]*class="[^"]*kb-pdf[^"]*"[^>]*>\s*<\/iframe>\s*$/i;
const ATTACH_LINE = /^<a\b[^>]*class="[^"]*kb-attach[^"]*"[^>]*>([\s\S]*?)<\/a>\s*$/i;
const PAGEBREAK_LINE = /^<div\b[^>]*class="[^"]*kb-page-break[^"]*"[^>]*>\s*(?:<\/div>)?\s*$/i;
const SUMMARY_LINE = /^<summary[^>]*>([\s\S]*?)<\/summary>\s*$/i;

// B3: 标题 slug 生成——保留中英文 + 数字，小写化 + 去重音，空格转 -
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\u2000-\u206f\u2e00-\u2e7f'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40) || "untitled";
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  const listStack: { tag: "ul" | "ol"; ordered: boolean }[] = [];
  const closeLists = () => {
    while (listStack.length) {
      const t = listStack.pop()!;
      out.push(`</li></${t.tag}>`);
    }
  };

  // E-1：块对齐标记 <!-- align:center|right -->（blocksToMd 序列化产出）。
  // 注释行本身不输出，作用于紧邻的下一个标题/段落。
  const ALIGN_MARK = /^<!--\s*align:(center|right)\s*-->$/;
  let pendingAlign: "center" | "right" | null = null;
  const alignAttr = () => {
    const a = pendingAlign;
    pendingAlign = null;
    return a ? ` style="text-align:${a}"` : "";
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // 对齐标记行：记录后跳过
    const am = ALIGN_MARK.exec(line.trim());
    if (am) {
      pendingAlign = am[1] as "center" | "right";
      i++;
      continue;
    }

    // 代码块
    if (line.trimStart().startsWith("```")) {
      closeLists();
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // 跳过结束 ```
      // 画布内嵌：输出占位节点，React 预览层增强为可交互预览器
      if (lang === "canvas-embed") {
        const docId = buf.join("\n").trim().replace(/[^a-zA-Z0-9]/g, "");
        out.push(`<div class="md-canvas-embed" data-canvas-doc="${escapeHtml(docId)}"></div>`);
        continue;
      }
      out.push(`<pre class="md-pre"><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // 数学公式块 $$ ... $$
    if (line.trimStart().startsWith("$$")) {
      closeLists();
      const rest = line.trim().slice(2);
      if (rest.endsWith("$$") && rest.length > 2) {
        out.push(`<div class="md-math-block">${escapeHtml(rest.slice(0, -2).trim())}</div>`);
        i++;
        continue;
      }
      const buf: string[] = rest ? [rest] : [];
      i++;
      while (i < lines.length && !lines[i]!.trim().endsWith("$$")) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // 跳过结束 $$
      out.push(`<div class="md-math-block">${escapeHtml(buf.join("\n").trim())}</div>`);
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      closeLists();
      out.push('<hr class="md-hr" />');
      i++;
      continue;
    }

    // 分页符
    if (PAGEBREAK_LINE.test(line.trim())) {
      closeLists();
      out.push('<div class="md-page-break"><span>分页符</span></div>');
      i++;
      continue;
    }

    // 视频
    if (VIDEO_LINE.test(line.trim())) {
      closeLists();
      const src = attrOf(line.trim(), "src");
      const title = attrOf(line.trim(), "title") || "视频";
      // E-1：src 过 URL 白名单（javascript:/data:text/html 等降级为转义文本，防 XSS）
      if (!isSafeUrl(src)) {
        out.push(`<p>${escapeHtml(line.trim())}</p>`);
      } else {
        out.push(
          `<figure class="md-media md-video"><video src="${escapeHtml(src)}" controls preload="metadata"></video>` +
          `<figcaption>${escapeHtml(title)}</figcaption></figure>`,
        );
      }
      i++;
      continue;
    }

    // 音频
    if (AUDIO_LINE.test(line.trim())) {
      closeLists();
      const src = attrOf(line.trim(), "src");
      const title = attrOf(line.trim(), "title") || "音频";
      if (!isSafeUrl(src)) {
        out.push(`<p>${escapeHtml(line.trim())}</p>`);
      } else {
        out.push(
          `<figure class="md-media md-audio"><audio src="${escapeHtml(src)}" controls preload="metadata"></audio>` +
          `<figcaption>${escapeHtml(title)}</figcaption></figure>`,
        );
      }
      i++;
      continue;
    }

    // PDF 嵌入
    if (PDF_LINE.test(line.trim())) {
      closeLists();
      const src = attrOf(line.trim(), "src");
      const title = attrOf(line.trim(), "title") || "PDF 文档";
      if (!isSafeUrl(src)) {
        out.push(`<p>${escapeHtml(line.trim())}</p>`);
      } else {
        out.push(
          `<figure class="md-media md-pdf"><iframe class="kb-pdf" src="${escapeHtml(src)}" title="${escapeHtml(title)}"></iframe>` +
          `<figcaption><a href="${escapeHtml(src)}" target="_blank" rel="noreferrer" class="md-link">在新窗口打开 PDF：${escapeHtml(title)}</a></figcaption></figure>`,
        );
      }
      i++;
      continue;
    }

    // 附件
    {
      const am = ATTACH_LINE.exec(line.trim());
      if (am) {
        closeLists();
        const tag = line.trim().slice(0, line.trim().indexOf(">") + 1);
        const href = attrOf(tag, "href");
        const name = am[1]!.trim() || "附件";
        out.push(
          `<a class="md-attach" href="${escapeHtml(href)}" download target="_blank" rel="noreferrer">` +
          `<span class="md-attach-icon">FILE</span><span class="md-attach-name">${escapeHtml(name)}</span>` +
          `<span class="md-attach-dl">下载</span></a>`,
        );
        i++;
        continue;
      }
    }

    // 折叠块 <details><summary>..</summary> ... </details>（支持同行写法与单行完整写法）
    if (/^<details\b/i.test(line.trim())) {
      closeLists();
      let rest = line.trim().replace(/^<details\b[^>]*>/i, "");
      let summary = "折叠块";
      const inlineSum = SUMMARY_LINE.exec(rest);
      let closedOnOpenLine = false;
      const buf: string[] = [];
      if (inlineSum) {
        summary = inlineSum[1]!;
        rest = rest.replace(SUMMARY_LINE, "");
      }
      if (/<\/details>/i.test(rest)) {
        const before = rest.split(/<\/details>/i)[0] ?? "";
        if (before.trim()) buf.push(before.trim());
        closedOnOpenLine = true;
      }
      let j = i + 1;
      if (!inlineSum && !closedOnOpenLine && j < lines.length && SUMMARY_LINE.test(lines[j]!.trim())) {
        summary = SUMMARY_LINE.exec(lines[j]!.trim())![1]!;
        j++;
      }
      while (!closedOnOpenLine && j < lines.length) {
        const cur = lines[j]!;
        if (/<\/details>/i.test(cur)) {
          const before = cur.split(/<\/details>/i)[0] ?? "";
          if (before.trim()) buf.push(before.trim());
          break;
        }
        buf.push(cur);
        j++;
      }
      j = closedOnOpenLine ? i + 1 : j + 1; // 跳过 </details> 所在行
      out.push(
        `<details class="md-toggle"><summary>${inline(summary)}</summary>` +
        `<div class="md-toggle-body">${renderMarkdown(buf.join("\n"))}</div></details>`,
      );
      i = j;
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeLists();
      const level = h[1]!.length;
      // B3: 标题锚点 id——基于文本生成稳定 slug（中文保留），用于 URL hash 跳转
      const slug = `h-${slugify(h[2] ?? "")}`;
      out.push(`<h${level} class="md-h md-h${level}" data-heading-id="${escapeHtml(slug)}"${alignAttr()}>${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }

    // 表格（当前行含 | 且下一行是分隔行）
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!)) {
      closeLists();
      const splitRow = (r: string): string[] => {
        let t = r.trim();
        if (t.startsWith("|")) t = t.slice(1);
        if (t.endsWith("|")) t = t.slice(0, -1);
        return t.split("|").map((c) => c.trim());
      };
      const header = splitRow(line);
      i += 2; // 跳过表头与分隔行
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      // 合并单元格协议（与 blocks.ts 一致）：[[RxC]] 锚点 + :: 被覆盖 → 渲染 colSpan/rowSpan
      const allRows = [header, ...rows];
      const spans = parseTableSpans(allRows);
      const occ = tableOccupancy(allRows, spans);
      let table = '<table class="md-table"><thead><tr>';
      header.forEach((c, ci) => {
        if (occ.anchorAt[0]?.[ci] !== `${0},${ci}`) return; // 被覆盖格不输出
        const sp = spans?.[`0,${ci}`];
        const attrs = sp ? `${sp.cs > 1 ? ` colspan="${sp.cs}"` : ""}${sp.rs > 1 ? ` rowspan="${sp.rs}"` : ""}` : "";
        table += `<th${attrs}>${inline(stripSpanPrefix(c))}</th>`;
      });
      table += "</tr></thead><tbody>";
      for (let ri = 1; ri < allRows.length; ri++) {
        table += "<tr>";
        allRows[ri]!.forEach((c, ci) => {
          if (occ.anchorAt[ri]?.[ci] !== `${ri},${ci}`) return; // 被覆盖格不输出
          const sp = spans?.[`${ri},${ci}`];
          const attrs = sp ? `${sp.cs > 1 ? ` colspan="${sp.cs}"` : ""}${sp.rs > 1 ? ` rowspan="${sp.rs}"` : ""}` : "";
          table += `<td${attrs}>${inline(stripSpanPrefix(c))}</td>`;
        });
        table += "</tr>";
      }
      table += "</tbody></table>";
      out.push(table);
      continue;
    }

    // 引用 / 提示块（GitHub Alerts: > [!NOTE]/[!TIP]/[!WARNING]/[!IMPORTANT]/[!CAUTION]）
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeLists();
      const buf: string[] = [quote[1]!];
      i++;
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        buf.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      const alertRe = /^\s*\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*$/i;
      if (buf.length > 0 && alertRe.test(buf[0]!)) {
        const variant = alertRe.exec(buf[0]!)![1]!.toLowerCase();
        const labelMap: Record<string, string> = {
          note: "提示", tip: "技巧", warning: "注意", important: "重要", caution: "警告",
        };
        const body = buf.slice(1).filter((l) => l.trim() !== "").join("\n");
        out.push(
          `<div class="md-callout md-callout-${variant}">` +
          `<div class="md-callout-title">${labelMap[variant] ?? variant.toUpperCase()}</div>` +
          `<div class="md-callout-body">${renderMarkdown(body)}</div></div>`,
        );
      } else {
        out.push(`<blockquote class="md-quote">${inline(buf.join("<br/>"))}</blockquote>`);
      }
      continue;
    }

    // 列表项（无序 / 有序 / 任务）
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      const indent = (ul ? ul[1]! : ol![1]!).length;
      const ordered = !!ol;
      const content = ul ? ul[2]! : ol![3]!;
      const targetDepth = Math.floor(indent / 2) + 1;
      while (listStack.length < targetDepth) {
        const tag = ordered ? "ol" : "ul";
        if (listStack.length > 0) out.push("<ul class='md-nested'>");
        out.push(`<${tag} class="md-list">`);
        listStack.push({ tag, ordered });
      }
      while (listStack.length > targetDepth) {
        const t = listStack.pop()!;
        out.push(`</li></${t.tag}>`);
      }
      // 任务列表
      const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
      if (task) {
        const checked = task[1]!.toLowerCase() === "x";
        out.push(
          `<li class="md-task"><label><input type="checkbox" disabled ${checked ? "checked" : ""} class="md-task-box"/> <span class="${checked ? "md-task-done" : ""}">${inline(task[2]!)}</span></label>`,
        );
      } else {
        out.push(`<li class="md-li">${inline(content)}`);
      }
      i++;
      continue;
    }

    // 空行
    if (line.trim() === "") {
      closeLists();
      i++;
      continue;
    }

    // 普通段落（合并连续非空非特殊行）
    closeLists();
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,6})\s/.test(lines[i]!) &&
      !/^\s*[-*+]\s/.test(lines[i]!) &&
      !/^\s*\d+\.\s/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!) &&
      !lines[i]!.trimStart().startsWith("```") &&
      !lines[i]!.trimStart().startsWith("$$") &&
      !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i]!) &&
      !/^<(video|audio|iframe|a|div|details|\/details)\b/i.test(lines[i]!.trim()) &&
      !/^<summary\b/i.test(lines[i]!.trim()) &&
      !ALIGN_MARK.test(lines[i]!.trim()) &&
      !(lines[i]!.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!))
    ) {
      buf.push(lines[i]!);
      i++;
    }
    out.push(`<p class="md-p"${alignAttr()}>${inline(buf.join("<br/>"))}</p>`);
  }
  closeLists();
  return out
    .join("\n")
    // 成员提及 @[u:id|名] → chip（label 已在上方转义，安全）
    .replace(/@\[u:([^|\]]+)\|([^\]]+)\]/g, (_m, _id, label) => `<span class="md-mention">@${label}</span>`);
}
