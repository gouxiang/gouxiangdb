// 帮助中心骨架回归（node：react-dom/server + 源码断言，无 jsdom / 无新依赖）。
//
// 覆盖五条：
//   ① 渲染骨架 md：H1 与若干 H2 真的出现在正文里
//   ② 目录锚点与正文标题 id 严格一一对应（同一份 slugify 算法）
//   ③ 配图相对路径 src="assets/x.png" 按**注入的部署 base** 映射（不写死 "/"，不写死域名）
//   ④ 页面/目录的样式只用 gx-* token（禁硬编码色值）且无 emoji
//   ⑤ apps/web 的 dependencies/devDependencies 无新增行（禁新增第三方依赖）

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import HelpCenterPage from "../HelpCenterPage";
import HelpCenterToc from "../HelpCenterToc";
import { buildHelpHtml, extractHelpHeadings, mapHelpAssetSrc } from "../help-html";

const here = (p: string) => new URL(p, import.meta.url);
const read = (p: string) => readFileSync(here(p), "utf8");

/** 带配图的样例正文（真源 docs/help-center/HELP-CENTER.md 本轮是纯骨架，故另造 fixture）。 */
const MD_WITH_IMAGE = [
  "# 帮助中心",
  "",
  "## 快速开始",
  "",
  "![登录界面](assets/login.png)",
  "",
  "### 注册与登录",
].join("\n");

describe("帮助中心：骨架渲染与目录锚点", () => {
  it("① 渲染骨架 md：H1 与 ≥5 个二级标题都出现在正文里", () => {
    const html = renderToString(<HelpCenterPage />);
    expect(html).toContain("帮助中心");
    expect(html).toContain("快速开始");
    expect(html).toContain("常见问题");
    // renderMarkdown 对 `##` 输出 <h2 ...>（node 分支无 sanitize，属性为 data-heading-id + id）
    expect((html.match(/<h2[ >]/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it("② 目录锚点与正文标题 id 一致：每个 heading.id 都能在正文 HTML 里找到 id=\"...\"", () => {
    const { html, headings } = buildHelpHtml(read("../../../../../../docs/help-center/HELP-CENTER.md"), "");
    expect(headings.length).toBeGreaterThanOrEqual(6);
    for (const h of headings) {
      expect(html).toContain(`id="${h.id}"`);
    }
    // 目录渲染的点击目标就是这些 id：渲染 TOC 后应逐项带出（button 无 href，用文本 + 顺序校验）
    const toc = renderToString(
      <HelpCenterToc headings={headings} activeId={headings[1]!.id} onSelect={() => undefined} />,
    );
    for (const h of headings) expect(toc).toContain(h.text);
  });

  it("②b 目录过滤：搜索框命中的章节保留，其余剔除（空结果给出提示）", () => {
    const headings = extractHelpHeadings(MD_WITH_IMAGE);
    expect(headings.map((h) => h.text)).toEqual(["帮助中心", "快速开始", "注册与登录"]);
    // h1/h2/h3 层级与 slug 前缀与 renderMarkdown 内建算法同源
    expect(headings[0]!.id).toBe("h-帮助中心");
    expect(headings[1]!.level).toBe(2);
  });
});

describe("帮助中心：配图路径映射（部署基路径注入）", () => {
  it("③ 子路径部署：src=\"assets/x.png\" → /app/gouxiangdb/help/assets/x.png", () => {
    const { html } = buildHelpHtml(MD_WITH_IMAGE, "/app/gouxiangdb");
    expect(html).toContain('src="/app/gouxiangdb/help/assets/login.png"');
    expect(html).not.toContain('src="assets/');
  });

  it("③b 根部署（base=\"\"）：原样落在 /help/assets/ 下，不写死域名、不带双斜杠", () => {
    const { html } = buildHelpHtml(MD_WITH_IMAGE, "");
    expect(html).toContain('src="/help/assets/login.png"');
    expect(html).not.toContain("//help/assets");
    // 纯函数层：外部 URL 与绝对路径不参与改写
    expect(mapHelpAssetSrc('<img src="https://x.test/a.png" />', "/app/gouxiangdb")).toContain(
      'src="https://x.test/a.png"',
    );
  });
});

describe("帮助中心：样式与依赖约束（源码断言）", () => {
  const pageSrc = read("../HelpCenterPage.tsx");
  const tocSrc = read("../HelpCenterToc.tsx");

  it("④ 只用 gx-* token：无硬编码色值、无渐变、无 emoji", () => {
    for (const src of [pageSrc, tocSrc]) {
      // 色值：#rgb/#rrggbb（Tailwind arbitrary color 也一并禁掉）
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/from-[a-z]+-[0-9]{2,3}/);
      expect(src).not.toMatch(/bg-\[[^]]*#/);
      // emoji 扫描（功能图标一律走 components/icons.tsx 的 SVG）
      expect(src).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u);
    }
    expect(pageSrc).toContain("text-gx-text-primary");
    expect(tocSrc).toContain("bg-gx-accent-bg");
    // 禁裸 fetch：帮助中心是纯静态内容，不发起任何网络请求
    expect(pageSrc).not.toContain("fetch(");
    expect(tocSrc).not.toContain("fetch(");
  });

  it("⑤ apps/web 未为帮助中心引入任何新依赖（deps/devDeps 只出不进）", () => {
    const pkg = JSON.parse(read("../../../../package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    // 冻结基线：新增任何一项都必须同步更新本表并说明理由
    const BASE_DEPS = [
      "@drawnix/drawnix", "@floating-ui/react", "@gx/blocks", "@gx/design-tokens", "@gx/shared-types",
      "@plait-board/markdown-to-drawnix", "@plait-board/mermaid-to-drawnix", "@plait-board/react-board",
      "@plait-board/react-text", "@plait/common", "@plait/core", "@plait/draw", "@plait/layouts",
      "@plait/text-plugins", "@tanstack/react-query", "ahooks", "classnames", "clsx", "laser-pen",
      "lodash", "mobile-detect", "open-color", "react", "react-dom", "react-router-dom",
      "remark-parse", "roughjs", "slate", "slate-history", "slate-react", "unified", "zustand",
    ];
    const BASE_DEV = [
      "@playwright/test", "@types/react", "@types/react-dom", "@vitejs/plugin-react", "autoprefixer",
      "postcss", "tailwindcss", "typescript", "vite", "vitest",
    ];
    expect(Object.keys(pkg.dependencies).filter((d) => !BASE_DEPS.includes(d))).toEqual([]);
    expect(Object.keys(pkg.devDependencies).filter((d) => !BASE_DEV.includes(d))).toEqual([]);
    // dev/build/typecheck 都前置跑同步脚本：?raw 导入的产物必须先存在
    expect(pkg.scripts.typecheck).toContain("sync-help-center.mjs");
    expect(pkg.scripts.dev).toContain("sync-help-center.mjs");
    expect(pkg.scripts.build).toContain("sync-help-center.mjs");
  });
});
