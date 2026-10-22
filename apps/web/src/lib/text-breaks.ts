// apps/web/src/lib/text-breaks.ts
// 把「历史数据里混入的字面 <br>/<br/>/<br />」归一化成真实换行符。
//
// 背景：长文本字段（多行文本）经 markdown 渲染管线（@gx/blocks 的 inlineMdToHtml /
// renderMarkdown）展示。管线会先对正文做 HTML 转义：真实换行 `\n` 会被正确转成
// `<br/>`，但**历史脏数据里已经写死的字面 `<br/>`** 会被转义成可见的 `&lt;br/&gt;`
// 泄漏到界面。这里在送入渲染器之前把字面 br 标签等价还原成 `\n`，二者渲染结果一致。
//
// 关键：必须是「围栏/行内代码感知」的。代码块或 `code` 里出现的 `<br>` 是作者要展示的
// 示例文本，绝不能替换，否则会破坏代码示例。纯函数、不碰 DOM，便于 node 单测。

const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/;
/** 字面换行标签：<br>、<br/>、<br /> 及其大写形态（HTML 标签大小写不敏感）。 */
const BR_TAG = /<br\s*\/?>/gi;

/**
 * 把一行内的行内代码段（`code` / `` `code` `` 等长反引号串）替换为私用区占位符，
 * 返回占位后的行与代码段数组。CommonMark 要求开闭反引号串等长；找不到配对的反引号
 * 按普通字符放过（不把半行正文误判成代码）。与 help-html 的同款扫描保持一致。
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
    // 私用区码位占位：绝不会出现在正常正文里
    masked += `\uE000${spans.length - 1}\uE000`;
    i = closeEnd;
  }
  return { masked, spans };
}

/** 处理围栏外的一行：先摘出行内代码，再把字面 br 标签换成真实换行，最后还原代码。 */
function normalizeLine(line: string): string {
  const { masked, spans } = stashInlineCode(line);
  const replaced = masked.replace(BR_TAG, "\n");
  // 整行只有 <br>（如 "a\n<br/>\nb" 里它代表一个空行）：归一为空串，
  // 否则该元素自带的 \n 与外层 join("\n") 叠加会多出一个空行。
  const result = replaced.replace(/\uE000(\d+)\uE000/g, (m, idx: string) => spans[Number(idx)] ?? m);
  return /^\n*$/.test(result) ? "" : result;
}

/**
 * 把正文中（围栏代码块之外、行内代码之外）的字面 `<br>` 系列标签归一化为真实换行。
 *
 * 跳过：
 *   - 围栏代码块（``` 与 ~~~，含开栏行与未闭合围栏，整段原样保留）；
 *   - 行内代码 `code`（其中的 `<br>` 是示例，不替换）。
 *
 * 已含真实换行的内容不受影响（输出保持等价换行）；幂等：对已是 `\n` 的输入再跑一次无变化。
 */
export function normalizeLiteralLineBreaks(md: string): string {
  if (!md || !/<br\s*\/?>/i.test(md)) return md;
  const lines = md.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
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
        return line; // 围栏内：原样保留（含字面 <br> 示例）
      }
      if (mark) {
        fenceChar = mark[0] as "`" | "~";
        fenceLen = mark.length;
        return line; // 开栏行本身不处理
      }
      return normalizeLine(line);
    })
    .join("\n");
}

/** 转义后的字面换行标签形态：源里写死的 <br> 系列，以及渲染器在段落内插入的连接标记。 */
const ESCAPED_BR = /&lt;br\s*\/?&gt;/gi;

/**
 * 在「渲染后 HTML」里把转义形态的换行标签还原为 `replacement`，但结构性地保护代码：
 * 先把 `<pre>…</pre>` 代码块与 `<code>…</code>` 行内代码整体摘出占位（其中出现的
 * `&lt;br&gt;` 是要展示的示例文本，绝不能动），还原后再原样放回。
 *
 * 这样不依赖具体容器标签（段落/引用/列表项内的换行都能修），且只在真正面向读者的
 * 富文本里替换。返回的 HTML 中代码示例字节不变。
 */
function restoreEscapedBreaks(html: string, replacement: string): string {
  const held: string[] = [];
  const masked = html.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>|<code\b[^>]*>[\s\S]*?<\/code>/gi, (m) => {
    held.push(m);
    return `\uE002${held.length - 1}\uE002`;
  });
  const fixed = masked.replace(ESCAPED_BR, replacement);
  return fixed.replace(/\uE002(\d+)\uE002/g, (m, i: string) => held[Number(i)] ?? m);
}

/**
 * 块级（renderMarkdown）输出的换行修复（仅用于多行文本字段详情）。
 *
 * 已证实的渲染器行为（packages/blocks markdown.ts）：普通段落会用**字面** `<br/>` 连接
 * 连续行，但该连接发生在行内 HTML 转义**之前**，于是这个 `<br/>` 也被转义成可见文本
 * `&lt;br/&gt;`；用户正文里写死的 `<br>` 系列同理（`&lt;br&gt;` 等）。
 * 而详情容器 `.md-cell-block .md-p { white-space: pre-wrap }` 表明：段落里的真实换行符
 * `\n` 本应原样保留、由 CSS 折成多行。
 *
 * 我们不改共享包（packages/* 禁改），而在 web 侧对**渲染后 HTML** 做精准还原：转义形态
 * 统一还原成真实换行 `\n`（由 pre-wrap 折行）；代码块/行内代码里的示例保持原样。
 *
 * 不会误伤：源里合法的 `<` 经转义是 `&lt;` 但后面不会精确跟 `br...&gt;`；真正的标签
 * （链接/图片等）不含 `&lt;br` 字样。
 */
export function restoreBlockLineBreaks(html: string): string {
  if (!html || !/&lt;br/i.test(html)) return html;
  return restoreEscapedBreaks(html, "\n");
}

/**
 * 帮助中心（help-html）专用：把渲染后 HTML 里转义的字面 `<br>` 系列还原成**真实 `<br/>`
 * 元素**。帮助正文容器不是 pre-wrap，必须插入真正的换行标签才能折行（sanitizeHtml 已放行
 * br 标签）。代码块/行内代码里的示例同样结构性保留。
 *
 * 入参是 renderMarkdown 的产物（已整体转义），因此这里注入的 `<br/>` 不会再被转义；
 * 调用方需在其后再走一次 sanitizeHtml（浏览器侧管线本就如此）。
 */
export function restoreHtmlBreaks(html: string): string {
  if (!html || !/&lt;br/i.test(html)) return html;
  return restoreEscapedBreaks(html, "<br/>");
}


