// help-html 纯函数回归（node 环境：无 jsdom，sanitize 走 node 跳过分支）。
//
// 覆盖：
//   ① rewriteWikiLinks：[[页面名]] / [[页面名|别名]] / 围栏代码块（``` 与 ~~~）不转 /
//      行内代码不转 / 一行多个
//   ② stripHtmlComments 仍工作（含围栏保护、跨行注释）
//   ③ buildHelpHtml(md)：输出含转换后的内部切页链接；图片路径不再由前端改写
//      （后端给的 /api/help/asset?path=... 绝对路径原样保留）
//   ④ extractHelpHeadings 与正文锚点 id 一一对应（含同名标题 -2 去重）

import { describe, expect, it } from "vitest";

import {
  attachHeadingIds,
  buildHelpHtml,
  extractHelpHeadings,
  filterHelpPages,
  rewriteWikiLinks,
  stripHtmlComments,
  WIKI_PAGE_HASH_PREFIX,
} from "../help-html";

describe("rewriteWikiLinks：Gitea 双链 → 内部切页 markdown 链接", () => {
  it("普通 [[页面名]]：别名缺省用页面名，URL 为 #help-page/<encodeURIComponent>", () => {
    const out = rewriteWikiLinks("详见 [[产品介绍]] 一文。");
    expect(out).toBe(`详见 [产品介绍](${WIKI_PAGE_HASH_PREFIX}${encodeURIComponent("产品介绍")}) 一文。`);
  });

  it("[[页面名|别名]]：链接文字用别名，目标仍是页面名", () => {
    const out = rewriteWikiLinks("见 [[快速开始|新手教程]]。");
    expect(out).toBe(`见 [新手教程](${WIKI_PAGE_HASH_PREFIX}${encodeURIComponent("快速开始")})。`);
  });

  it("一行多个双链全部转换", () => {
    const out = rewriteWikiLinks("[[A]] 与 [[B|别名B]] 还有 [[C]]");
    expect(out).toBe(
      `[A](${WIKI_PAGE_HASH_PREFIX}A) 与 [别名B](${WIKI_PAGE_HASH_PREFIX}B) 还有 [C](${WIKI_PAGE_HASH_PREFIX}C)`,
    );
  });

  it("围栏代码块内的双链是示例：``` 围栏（含 info string）不转，围栏外正常转", () => {
    const md = [
      "外链 [[页面甲]]",
      "",
      "```md",
      "代码里 [[页面乙]] 不转",
      "```",
      "",
      "外连 [[页面丙]]",
    ].join("\n");
    const out = rewriteWikiLinks(md);
    expect(out).toContain("代码里 [[页面乙]] 不转");
    expect(out).toContain(`[页面甲](${WIKI_PAGE_HASH_PREFIX}${encodeURIComponent("页面甲")})`);
    expect(out).toContain(`[页面丙](${WIKI_PAGE_HASH_PREFIX}${encodeURIComponent("页面丙")})`);
  });

  it("~~~ 波浪线围栏内的双链同样不转", () => {
    const md = ["~~~", "[[页面乙]]", "~~~", "[[页面甲]]"].join("\n");
    const out = rewriteWikiLinks(md);
    expect(out).toContain("[[页面乙]]");
    expect(out).toContain(`[页面甲](${WIKI_PAGE_HASH_PREFIX}${encodeURIComponent("页面甲")})`);
  });

  it("行内代码 `code` 内的双链不转（同行还有正常双链时互不影响）", () => {
    const out = rewriteWikiLinks("写 `[[页面乙]]` 这样，再链 [[页面甲]]。");
    expect(out).toContain("`[[页面乙]]`");
    expect(out).toContain(`[页面甲](${WIKI_PAGE_HASH_PREFIX}${encodeURIComponent("页面甲")})`);
    expect(out).not.toContain(`${WIKI_PAGE_HASH_PREFIX}${encodeURIComponent("页面乙")}`);
  });

  it("未闭合的围栏：围栏之后的内容按代码保护，不吞内容也不误转", () => {
    const out = rewriteWikiLinks("```\n[[页面乙]]\n没有收尾围栏");
    expect(out).toContain("[[页面乙]]");
    expect(out).toContain("没有收尾围栏");
  });
});

describe("stripHtmlComments：HTML 注释不泄漏（H-02 纯函数保留）", () => {
  it("删注释、保留前后正文；跨行注释不留孤立 -->", () => {
    expect(stripHtmlComments("正文 <!-- x --> 尾部")).toBe("正文  尾部");
    const out = stripHtmlComments("前段\n<!-- 跨行\n注释 -->\n后段");
    expect(out).not.toContain("注释");
    expect(out).not.toContain("-->");
    expect(out).toContain("前段");
    expect(out).toContain("后段");
  });

  it("围栏代码块内的 HTML 注释是示例，原样保留", () => {
    const out = stripHtmlComments("```html\n<!-- 示例，不删 -->\n```\n<!-- 作者标注，删 -->");
    expect(out).toContain("<!-- 示例，不删 -->");
    expect(out).not.toContain("作者标注");
  });
});

describe("buildHelpHtml(md)：新管线（无 base 参数、无图片改写）", () => {
  it("输出含转换后的内部切页链接（双链在渲染前完成转换）", () => {
    const { html } = buildHelpHtml("# 帮助\n\n详见 [[产品介绍]]。");
    expect(html).toContain(`href="${WIKI_PAGE_HASH_PREFIX}${encodeURIComponent("产品介绍")}"`);
    expect(html).not.toContain("[[产品介绍]]");
  });

  it("图片路径不再由前端改写：后端给的同源绝对路径与相对 images/ 都原样保留", () => {
    const md = [
      "# 帮助",
      "",
      "![后端改写](/api/help/asset?path=images%2Fa.png)",
      "",
      "![原样相对](images/b.png)",
    ].join("\n");
    const { html } = buildHelpHtml(md);
    expect(html).toContain('src="/api/help/asset?path=images%2Fa.png"');
    // 前端不再注入任何 /help-assets/ 前缀，也不改相对路径
    expect(html).not.toContain("/help-assets/");
    expect(html).toContain('src="images/b.png"');
  });

  it("HTML 注释不进正文（H-02 管线集成）", () => {
    const { html } = buildHelpHtml("# 标题\n\n<!-- IMG: 待补 -->\n正文");
    expect(html).not.toContain("<!--");
    expect(html).not.toContain("&lt;!--");
  });

  it("extractHelpHeadings 与回注的锚点 id 一一对应，同名标题追加 -2", () => {
    const md = ["# 帮助中心", "", "## 全局搜索", "", "第一段", "", "## 全局搜索", "", "第二段"].join("\n");
    const { html, headings } = buildHelpHtml(md);
    const ids = headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("h-全局搜索");
    expect(ids).toContain("h-全局搜索-2");
    for (const h of headings) expect(html).toContain(`id="${h.id}"`);
    // 回注顺序：第二个锚点在第一个之后
    expect(html.indexOf('id="h-全局搜索-2"')).toBeGreaterThan(html.indexOf('id="h-全局搜索"'));
  });

  it("围栏内的 # 不当标题抽取", () => {
    const headings = extractHelpHeadings("# 真标题\n\n```\n# 代码里的井号\n```\n## 真小节");
    expect(headings.map((h) => h.text)).toEqual(["真标题", "真小节"]);
    // attachHeadingIds 对数量不一致只注前 n 个、不越界
    expect(() => attachHeadingIds("<h1>a</h1><h2>b</h2>", headings)).not.toThrow();
  });
});

describe("filterHelpPages：左栏按页面标题过滤", () => {
  const pages = [
    { title: "Home", href: "Home" },
    { title: "产品介绍", href: "产品介绍" },
    { title: "全局搜索", href: "全局搜索" },
  ];
  it("中文子串 includes 命中；空串返回全量副本", () => {
    expect(filterHelpPages(pages, "搜索").map((p) => p.title)).toEqual(["全局搜索"]);
    expect(filterHelpPages(pages, "  ")).toHaveLength(3);
    const all = filterHelpPages(pages, "");
    all.push({ title: "x", href: "x" });
    expect(pages).toHaveLength(3);
  });
});
