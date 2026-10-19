// HelpCenterPage 在线百科改造的「源码契约 + SSR 初始态」回归（node：无 jsdom，不引
// react-testing-library/msw 等新依赖）。
//
// 为什么不做异步交互测试：页面的三态（loading/error/ready）由 fetch + setState 驱动，
// node SSR（renderToString）不跑 useEffect，正好锁死「挂载即 loading」的首帧契约；
// 请求/降级/切页的接线用源码断言锁死，避免为测异步引入新依赖。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import HelpCenterPage from "../HelpCenterPage";

const here = (p: string) => new URL(p, import.meta.url);
const read = (p: string) => readFileSync(here(p), "utf8");

const pageSrc = read("../HelpCenterPage.tsx");
const apiSrc = read("../help-api.ts");
const htmlSrc = read("../help-html.ts");
const tocSrc = read("../HelpCenterToc.tsx");

describe("HelpCenterPage：内嵌 md 管线已拆除，改走在线百科代理", () => {
  it("SSR 首帧是中文「加载中…」，不白屏（useEffect 在 SSR 不发请求）", () => {
    const html = renderToString(<HelpCenterPage />);
    expect(html).toContain("加载中…");
  });

  it("不再 import generated，也没有任何 ?raw 导入", () => {
    expect(pageSrc).not.toMatch(/generated\//);
    expect(pageSrc).not.toContain("?raw");
    for (const src of [apiSrc, htmlSrc, tocSrc]) expect(src).not.toContain("?raw");
  });

  it("请求统一走 api/client：help-api 复用 apiFetch，任何文件都不出现裸全局 fetch 调用", () => {
    expect(apiSrc).toContain('from "../../api/client"');
    expect(apiSrc).toContain("apiFetch");
    // \b 保证 apiFetch( 不被误判为裸 fetch（h 与 f 之间无词边界）
    expect(pageSrc).not.toMatch(/\bfetch\s*\(/);
    expect(apiSrc).not.toMatch(/\bfetch\s*\(/);
  });

  it("请求的是同源后端代理端点 /api/help/wiki，切页带 page 查询参数", () => {
    expect(apiSrc).toContain("/api/help/wiki");
    expect(apiSrc).toContain("encodeURIComponent");
  });

  it("离线降级：识别 WIKI_UNREACHABLE，正文区有中文标题/说明/重试按钮，不抛英文堆栈", () => {
    expect(pageSrc).toContain("WIKI_UNREACHABLE");
    expect(pageSrc).toContain("暂时无法连接帮助百科");
    expect(pageSrc).toContain("请检查网络或稍后重试");
    expect(pageSrc).toContain("重试");
  });

  it("双链切页：事件委托拦截 #help-page/ 链接并 preventDefault + decodeURIComponent", () => {
    expect(pageSrc).toContain("WIKI_PAGE_HASH_PREFIX");
    expect(pageSrc).toContain("preventDefault");
    expect(pageSrc).toContain("decodeURIComponent");
    expect(htmlSrc).toContain("export function rewriteWikiLinks");
  });

  it("前端不再做图片路径改写：help-html 已删除 HELP_ASSET_PATH / mapHelpAssetSrc", () => {
    expect(htmlSrc).not.toContain("HELP_ASSET_PATH");
    expect(htmlSrc).not.toContain("mapHelpAssetSrc");
    expect(htmlSrc).not.toContain("help-assets");
  });
});

describe("HelpCenterPage / Toc：样式与依赖约束（源码断言）", () => {
  it("只用 gx-* token：无硬编码色值、无渐变、无 emoji；保留 gx-accent-bg 高亮", () => {
    for (const src of [pageSrc, tocSrc]) {
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/from-[a-z]+-[0-9]{2,3}/);
      expect(src).not.toMatch(/bg-\[[^]]*#/);
      expect(src).not.toMatch(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u);
    }
    expect(pageSrc).toContain("text-gx-text-primary");
    expect(tocSrc).toContain("bg-gx-accent-bg");
  });
});

describe("apps/web package.json：同步脚本接线已拆除，依赖零新增", () => {
  const pkg = JSON.parse(read("../../../../package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };

  it("dev/build/typecheck/test/test:unit 五条脚本不再前置 sync-help-center.mjs，sync:help 已删", () => {
    for (const key of ["dev", "build", "typecheck", "test", "test:unit"]) {
      expect(pkg.scripts[key]).not.toContain("sync-help-center.mjs");
    }
    expect(pkg.scripts).not.toHaveProperty("sync:help");
    expect(pkg.scripts.build).toBe("tsc && vite build");
    expect(pkg.scripts.dev).toBe("vite");
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");
    expect(pkg.scripts.test).toBe("vitest run --passWithNoTests");
    expect(pkg.scripts["test:unit"]).toBe("vitest run");
  });

  it("deps/devDeps 冻结基线（只出不进）", () => {
    // 冻结基线：新增任何一项都必须同步更新本表并说明理由（历史破例项见 git 记录：
    // Yjs 同步引擎三件套、Office 在线预览三件套，均为产品负责人书面例外）。
    const BASE_DEPS = [
      "@drawnix/drawnix", "@file-viewer/pptx", "@floating-ui/react", "@gx/blocks", "@gx/design-tokens",
      "@gx/shared-types", "@keep-lts/xlsx",
      "@plait-board/markdown-to-drawnix", "@plait-board/mermaid-to-drawnix", "@plait-board/react-board",
      "@plait-board/react-text", "@plait/common", "@plait/core", "@plait/draw", "@plait/layouts",
      "@plait/text-plugins", "@tanstack/react-query", "ahooks", "classnames", "clsx",
      "docx-preview", "laser-pen", "lodash", "mobile-detect", "open-color", "react", "react-dom",
      "react-router-dom", "remark-parse", "roughjs", "slate", "slate-history", "slate-react", "unified",
      "y-protocols", "y-websocket", "yjs", "zustand",
    ];
    const BASE_DEV = [
      "@playwright/test", "@types/react", "@types/react-dom", "@vitejs/plugin-react", "autoprefixer",
      "postcss", "tailwindcss", "typescript", "vite", "vitest",
    ];
    expect(Object.keys(pkg.dependencies).filter((d) => !BASE_DEPS.includes(d))).toEqual([]);
    expect(Object.keys(pkg.devDependencies).filter((d) => !BASE_DEV.includes(d))).toEqual([]);
  });
});
