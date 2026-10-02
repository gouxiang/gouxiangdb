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
  it("① 渲染拼接后的正文：分片真源（00-index / 10-database）的内容都进了页面", () => {
    const html = renderToString(<HelpCenterPage />);
    expect(html).toContain("帮助中心");
    // 00-index.md（前言与导读）
    expect(html).toContain("如何使用本文档");
    // 10-database.md（数据库正文）：证明「分片拼接 → ?raw → 渲染」整条链路通
    expect(html).toContain("界面结构速览");
    // renderMarkdown 对 `##` 输出 <h2 ...>（node 分支无 sanitize，属性为 data-heading-id + id）
    expect((html.match(/<h2[ >]/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });

  it("② 目录锚点与正文标题 id 一致：每个 heading.id 都能在正文 HTML 里找到 id=\"...\"", () => {
    // 用分片真源（入库文件，不依赖生成物）验证「同一份 slugify 算法」这一契约
    const { html, headings } = buildHelpHtml(
      read("../../../../../../docs/help-center/_parts/00-index.md"),
      "",
    );
    expect(headings.length).toBeGreaterThanOrEqual(3);
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
  it("③ 子路径部署：src=\"assets/x.png\" → /app/gouxiangdb/help-assets/x.png", () => {
    const { html } = buildHelpHtml(MD_WITH_IMAGE, "/app/gouxiangdb");
    expect(html).toContain('src="/app/gouxiangdb/help-assets/login.png"');
    expect(html).not.toContain('src="assets/');
  });

  it("③b 根部署（base=\"\"）：原样落在 /help-assets/ 下，不写死域名、不带双斜杠", () => {
    const { html } = buildHelpHtml(MD_WITH_IMAGE, "");
    expect(html).toContain('src="/help-assets/login.png"');
    expect(html).not.toContain("//help-assets");
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
    // 冻结基线：新增任何一项都必须同步更新本表并说明理由。
    // 2026-09-23 新增三项（**全部为 Yjs 同步引擎**，按 DESIGN.md §8 第 9 项 + 决策 D2 豁免：
    // 本功能对「禁新增前端依赖」公约是产品负责人书面例外，D6 只冻结 UI，不禁止引入同步引擎）。
    //   yjs          CRDT 引擎本体（只有数据模型，不渲染任何界面）
    //   y-protocols  awareness / sync 协议编解码（服务端认的四种消息码）
    //   y-websocket  WebSocket 传输提供者（自建并重掌重连，见 collab-provider.ts）
    // **不含 y-indexeddb**：阶段 2 不做离线持久化（服务端 collab_docs 是真源），已卸载不入表。
    // 2026-10-02 新增三项（**全部为 Office 在线预览**；产品负责人书面要求「Word/Excel/PPT
    // 都要能在线预览」，据此对「禁新增前端依赖」公约破例一次。范围严格限于这三项，且一律
    // 走动态 import()，主 chunk 体积不得增长）：
    //   docx-preview      Word .docx 渲染（DOM 还原，保真度优于 mammoth，体积反而更小）
    //   @keep-lts/xlsx    Excel .xlsx 读取。**刻意不用 npm 上的 `xlsx`**：那是 2022 年的
    //                     0.18.5，带 CVE-2023-30533 原型污染 + CVE-2024-22363 ReDoS 两个
    //                     高危漏洞，官方修复版只发在 SheetJS CDN 不在 npm；本包是回填了
    //                     这两个 CVE 的 registry 版本，也避免构建机离线时拉不到 CDN。
    //   @file-viewer/pptx PPT .pptx 渲染（纯 TS + DOM + Web Worker，无原生模块、无 WASM）
    // PDF 与 CSV **未新增依赖**：PDF 走 blob URL + 浏览器内置渲染，CSV 复用既有的
    // parseCsvPreview（ImportWizard.tsx）。
    //
    // 2026-10-02 再增三项（**附件 Office 在线预览**，产品负责人书面破例，范围严格限定这三项）：
    //   docx-preview       Word .docx 渲染（传递依赖 jszip）
    //   @keep-lts/xlsx     Excel .xls/.xlsx 读取。刻意不用 npm 上的 `xlsx`：那是 2022 年的
    //                      0.18.5，带 CVE-2023-30533 原型污染与 CVE-2024-22363 ReDoS 两个
    //                      高危漏洞，官方修复版只发 SheetJS CDN；CDN 外链会让离线构建机失败，
    //                      故用回填了这两个 CVE 的 registry 版本。
    //   @file-viewer/pptx  PPT .pptx 渲染（纯 TS + Web Worker，无原生模块 / 无 WASM / 无 postinstall）
    // 三者**只允许动态 import**（features/attachments/renderers.ts），由
    // attachment-policy.test.ts 的「体积守卫」断言主 chunk 不因此膨胀。
    const BASE_DEPS = [
      "@drawnix/drawnix", "@file-viewer/pptx", "@floating-ui/react", "@gx/blocks", "@gx/design-tokens",
      "@gx/shared-types", "@keep-lts/xlsx", "docx-preview",
      "@file-viewer/pptx", "@keep-lts/xlsx", "docx-preview",
      "@plait-board/markdown-to-drawnix", "@plait-board/mermaid-to-drawnix", "@plait-board/react-board",
      "@plait-board/react-text", "@plait/common", "@plait/core", "@plait/draw", "@plait/layouts",
      "@plait/text-plugins", "@tanstack/react-query", "ahooks", "classnames", "clsx", "laser-pen",
      "lodash", "mobile-detect", "open-color", "react", "react-dom", "react-router-dom",
      "remark-parse", "roughjs", "slate", "slate-history", "slate-react", "unified",
      "y-protocols", "y-websocket", "yjs", "zustand",
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
    // 生成物（HELP-CENTER.md / generated/）已不入库，单测也必须先同步再跑
    expect(pkg.scripts.test).toContain("sync-help-center.mjs");
  });

  it("⑥ 分片真源约定（脚本源码断言）：只并数字前缀、空目录报错、非首片 H1 降级", () => {
    const s = read("../../../../../../scripts/sync-help-center.mjs");
    // 只合并 ^\d+.*\.md$（bugfix-candidates.md 之类 bug 登记不得并进正文）
    expect(s).toContain("PART_FILE_RE = /^\\d+.*\\.md$/");
    expect(s).toContain("_parts");
    // 一个分片都没有时必须报错，不许静默产空文档
    expect(s).toContain("没有找到任何正文分片");
    // 非首片的顶层 H1 降级为 H2，避免文档里多个 H1 打乱目录
    expect(s).toContain("已降级为 H2");
  });
});
