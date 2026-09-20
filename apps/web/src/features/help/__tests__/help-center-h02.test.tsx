// H-02 回归：正文里的 HTML 注释（`<!-- IMG: 待补 … -->` 这类作者标注）不得泄漏成页面正文。
//
// 现象：帮助中心多处出现一串 `<!-- IMG: 待补 —— … -->`。
// 根因：markdown 渲染器把注释整行当文本处理并转义成 `&lt;!-- … --&gt;`。浏览器里
//       DOM 注释不可见，但**转义后是可见文本**，于是注释以正文形态出现在读者眼前。
// 修法：渲染前先过 stripHtmlComments（围栏代码块内的注释是示例，保留）。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildHelpHtml, extractHelpHeadings, stripHtmlComments } from "../help-html";

/** 真源产物（sync 脚本生成）：用它做「仓库内真文档」级别的回归。 */
const realHelpMd = () =>
  readFileSync(new URL("../../../../src/features/help/generated/help-center.md", import.meta.url), "utf8");

const MD_WITH_COMMENT = [
  "# 帮助中心",
  "",
  "## 界面结构速览",
  "",
  "<!-- IMG: 待补 —— 左侧导航、顶栏、正文三区 -->",
  "",
  "这里是正文。",
  "",
  "## MCP 接入",
  "",
  "<!-- IMG: 待补 —— 令牌列表 -->正文紧跟注释。",
].join("\n");

describe("H-02：HTML 注释不再泄漏为正文", () => {
  it("含注释的 md 渲染后：既没有 <!-- 也没有它的转义形态", () => {
    const { html } = buildHelpHtml(MD_WITH_COMMENT, "");
    expect(html).not.toContain("<!--");
    expect(html).not.toContain("&lt;!--");
    expect(html).not.toContain("IMG: 待补");
    expect(html).not.toContain("-->");
  });

  it("stripHtmlComments：① 删注释 ② 保留注释前后正文 ③ 围栏内的注释是示例，原样保留", () => {
    expect(stripHtmlComments("正文 <!-- x --> 尾部")).toBe("正文  尾部");
    // 整行只有注释 → 留空行，不把前后段落粘成一坨
    expect(stripHtmlComments("前段\n\n<!-- only -->\n\n后段").split("\n").filter(Boolean)).toEqual([
      "前段",
      "后段",
    ]);
    const withFence = [
      "```html",
      "<!-- 这是代码示例，不该被删 -->",
      "```",
      "<!-- 这是作者的待补标注，该删 -->",
    ].join("\n");
    const out = stripHtmlComments(withFence);
    expect(out).toContain("<!-- 这是代码示例，不该被删 -->");
    expect(out).not.toContain("待补标注");
  });

  it("跨行注释也一并删除，不留下孤立的 -->", () => {
    const out = stripHtmlComments("前段\n<!-- 跨行\n注释 -->\n后段");
    expect(out).not.toContain("注释");
    expect(out).not.toContain("-->");
    expect(out).toContain("前段");
    expect(out).toContain("后段");
  });

  it("清理注释不影响目录抽取：标题仍然抽得出来", () => {
    const headings = extractHelpHeadings(stripHtmlComments(MD_WITH_COMMENT));
    expect(headings.map((h) => h.text)).toEqual(["帮助中心", "界面结构速览", "MCP 接入"]);
  });

  it("现役真源文档（generated/help-center.md）渲染后无注释残留", () => {
    const { html } = buildHelpHtml(realHelpMd(), "");
    expect(html.includes("<!--") || html.includes("&lt;!--")).toBe(false);
    expect(html).not.toContain("IMG: 待补");
  });
});
