// 品牌外观面板 SSR 渲染回归（node：react-dom/server + 真实 QueryClient，无 jsdom）。
// 交互分支（类型/大小拦截、留空回退默认名）由 branding-panel-logic.test.ts 纯函数锁定；
// 这里锁两态渲染：未配置（默认）/ 已自定义，以及字段与隐藏 file input 的可达性标记。
import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrandingConfigDTO } from "@gx/shared-types";

// client 在 SSR 不发请求，但面板/hook 会引用 withBase 与 Branding 段，给桩避免真实模块副作用。
vi.mock("../../api/client", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public body: unknown,
    ) {
      super(`API ${status}`);
    }
  },
  withBase: (p: string) => `/app/gouxiangdb${p}`,
  Branding: {
    publicConfig: vi.fn(),
    adminConfig: vi.fn(),
    update: vi.fn(),
    uploadHero: vi.fn(),
    resetHero: vi.fn(),
  },
}));

import { QK } from "../../api/hooks";
import { BrandingPanel } from "./BrandingPanel";

function render(config?: BrandingConfigDTO): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  if (config) qc.setQueryData(QK.branding, config);
  return renderToString(
    <QueryClientProvider client={qc}>
      <BrandingPanel />
    </QueryClientProvider>,
  ).replace(/<!--[^>]*-->/g, "");
}

describe("BrandingPanel 未配置（默认品牌）", () => {
  const html = render();

  it("产品名输入框为空，placeholder 提示留空用默认名", () => {
    expect(html).toContain('id="branding-product-name"');
    expect(html).toContain("留空则使用默认名称「构想工作台」");
    expect(html).toContain('value=""');
  });

  it("广告图预览指向内置默认图（直拼 BASE_URL，不过 withBase）", () => {
    expect(html).toContain('src="/branding/login-hero.png"');
    expect(html).toContain("内置默认广告图");
  });

  it("默认态「恢复默认图」禁用（disabledReason 说明），无自定义可恢复", () => {
    expect(html).toContain("当前已是默认广告图");
    expect(html).toMatch(/<button[^>]*\bdisabled\b[^>]*>[\s\S]*?恢复默认图/);
  });

  it("保存按钮默认禁用（无脏改动）；隐藏的 file input 只收 jpg/png/webp", () => {
    expect(html).toMatch(
      /<button[^>]*\bdisabled\b[^>]*>[\s\S]*?保存名称与版权/,
    );
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain('type="file"');
  });

  it("长度上限来自 BRANDING_LIMITS 单一真源（30/120）", () => {
    expect(html).toContain("最多 30 字符");
    expect(html).toContain("/120");
  });
});

describe("BrandingPanel 已自定义品牌", () => {
  const html = render({
    productName: "星表私有云",
    copyright: "© {year} 星表科技",
    heroUrl: "/uploads/branding/hero.png?v=111",
  });

  it("产品名/版权回填（非默认名才进输入框），版权 {year} 实时预览为当前年份", () => {
    expect(html).toContain('value="星表私有云"');
    // <textarea> 的值在 SSR 下渲染为标签子文本（非 value 属性）
    expect(html).toMatch(
      /<textarea[^>]*id="branding-copyright"[^>]*>© \{year\} 星表科技<\/textarea>/,
    );
    expect(html).toContain(`© ${new Date().getFullYear()} 星表科技`);
  });

  it("自定义图 src 经 withBase 加子路径前缀，状态文案与「恢复默认图」可用", () => {
    expect(html).toContain(
      'src="/app/gouxiangdb/uploads/branding/hero.png?v=111"',
    );
    expect(html).toContain("已使用自定义广告图");
    // 自定义态下恢复按钮不带 disabledReason
    expect(html).not.toContain("当前已是默认广告图");
  });
});
