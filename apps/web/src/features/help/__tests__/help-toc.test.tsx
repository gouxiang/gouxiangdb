// HelpCenterToc 源码级回归（node：react-dom/server renderToString，无 jsdom）。
//
// 左栏已从「页内标题 TOC」改为「百科全站页面列表」：
//   - 列表渲染全部页面标题、当前页 gx-accent-bg 高亮（aria-current）
//   - 搜索框按页面标题过滤（过滤纯函数在 help-html.test.tsx 的 filterHelpPages 覆盖）
//   - 空结果中文提示

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import HelpCenterToc from "../HelpCenterToc";

const PAGES = [
  { title: "Home", href: "Home" },
  { title: "产品介绍", href: "产品介绍" },
  { title: "全局搜索", href: "全局搜索" },
];

describe("HelpCenterToc：百科页面列表", () => {
  it("渲染全部页面标题，逐行可点（button）", () => {
    const html = renderToString(
      <HelpCenterToc pages={PAGES} activeTitle="Home" onSelect={() => undefined} />,
    );
    for (const p of PAGES) expect(html).toContain(p.title);
    // 三行三个 button
    expect((html.match(/<button/g) ?? []).length).toBe(3);
  });

  it("当前页高亮沿用 gx-accent-bg，并打 aria-current", () => {
    const html = renderToString(
      <HelpCenterToc pages={PAGES} activeTitle="产品介绍" onSelect={() => undefined} />,
    );
    expect(html).toContain("bg-gx-accent-bg");
    expect(html).toContain('aria-current="true"');
  });

  it("空列表给中文空结果提示（无匹配页面时不白屏）", () => {
    const html = renderToString(
      <HelpCenterToc pages={[]} activeTitle="" onSelect={() => undefined} />,
    );
    expect(html).toContain("没有匹配的页面");
  });

  it("紧凑档与常驻档都渲染搜索框（placeholder 为页面语义，非旧的章节语义）", () => {
    for (const compact of [false, true]) {
      const html = renderToString(
        <HelpCenterToc pages={PAGES} activeTitle="Home" onSelect={() => undefined} compact={compact} />,
      );
      expect(html).toContain("搜索页面");
      expect(html).not.toContain("搜索章节");
    }
  });
});
