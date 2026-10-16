// 品牌外观面板 SSR 渲染回归（node：react-dom/server + 真实 QueryClient，无 jsdom）。
// 覆盖：owner 下自定义/默认两种 dto 的字段回填与预览、非 owner 与 isLoading 双保险 return null、
// 恢复默认图按钮仅自定义态出现。交互/校验细则由 branding-settings-logic.test.ts 纯函数锁定。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BrandingConfigDTO } from "@gx/shared-types";

// 可控的 owner 信号（双保险：非 owner / 探针未回都必须 return null）。
let ownerState: { isOwner: boolean; isLoading: boolean } = {
  isOwner: true,
  isLoading: false,
};

vi.mock("../contacts/contacts-hooks", () => ({
  useIsWorkspaceOwner: () => ownerState,
}));

// client 在 SSR 不发请求，但面板/hook 引用 withBase 与 Branding 段，给桩避免真实模块副作用。
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
import { BrandingSettingsPanel } from "./BrandingSettingsPanel";

function render(config?: BrandingConfigDTO): string {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  if (config) qc.setQueryData(QK.branding, config);
  return renderToString(
    <QueryClientProvider client={qc}>
      <BrandingSettingsPanel />
    </QueryClientProvider>,
  ).replace(/<!--[^>]*-->/g, "");
}

beforeEach(() => {
  ownerState = { isOwner: true, isLoading: false };
});

describe("owner + 自定义品牌 dto", () => {
  const html = render({
    productName: "星表私有云",
    copyright: "© {year} 星表科技",
    heroUrl: "/uploads/branding/hero.png?v=1",
    signupOpen: true,
    serverBaseUrl: "https://gx.example.com",
  });

  it("三行标签与头行操作齐全，产品名直接回填（哪怕等于默认名也回填）", () => {
    expect(html).toContain("产品显示名称");
    expect(html).toContain("版权信息");
    expect(html).toContain("登录页广告图");
    expect(html).toContain("服务器访问网址");
    expect(html).toContain('value="https://gx.example.com"');
    expect(html).toContain("恢复默认文案");
    expect(html).toContain(">保存<");
    expect(html).toContain('id="branding-product-name"');
    expect(html).toContain('value="星表私有云"');
  });

  it("访客自主注册第四行可见：标签 + 说明文案齐全；signupOpen=true 时开关轨为强调色", () => {
    expect(html).toContain("允许访客自主注册");
    expect(html).toContain("默认普通成员，由管理员分配权限");
    expect(html).toContain("系统首次初始化创建超管不受此开关影响");
    // Switch 选中态：轨道走 bg-gx-accent（未选中为 bg-gx-border-strong）。
    expect(html).toContain("bg-gx-accent");
  });

  it("版权回填为 textarea 子文本，{year} 实时预览为当前年份，计数走单一真源", () => {
    expect(html).toMatch(
      /<textarea[^>]*id="branding-copyright"[^>]*>© \{year\} 星表科技<\/textarea>/,
    );
    expect(html).toContain(`© ${new Date().getFullYear()} 星表科技`);
    expect(html).toContain("/30");
    expect(html).toContain("/120");
  });

  it("自定义图 src 过 withBase，出现「恢复默认图」与上传按钮，file input 只收三 MIME", () => {
    expect(html).toContain(
      'src="/app/gouxiangdb/uploads/branding/hero.png?v=1"',
    );
    expect(html).toContain("恢复默认图");
    expect(html).toContain("上传图片");
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
  });
});

describe("owner + 默认品牌（heroUrl=null / 默认产品名）", () => {
  const html = render(); // 不预置数据 → placeholderData=DEFAULT_BRANDING

  it("默认产品名也直接回填显示（不再把默认名呈现为空 + 留空提示）", () => {
    expect(html).toContain('value="构想工作台"');
    expect(html).not.toContain("留空则使用默认名称");
  });

  it("预览指向内置默认图，且不出现「恢复默认图」按钮（无自定义可恢复）", () => {
    expect(html).toContain('src="/branding/login-hero.png"');
    expect(html).not.toContain("恢复默认图");
  });

  it("空名无法保存的引导文案在（恢复默认请点头部按钮）", () => {
    expect(html).toContain("留空无法保存");
  });

  it("注册开关默认关（DEFAULT_BRANDING.signupOpen=false）：轨道非强调色，行仍可见", () => {
    // 默认 dto 未显式给 signupOpen，checked = config?.signupOpen === true → false。
    expect(html).toContain("允许访客自主注册");
    expect(html).toContain("bg-gx-border-strong");
  });
});

describe("访客自主注册开关 checked 反映 config.signupOpen", () => {
  it("signupOpen=false（显式）→ 开关轨为非强调色", () => {
    const html = render({
      productName: "星表私有云",
      copyright: "",
      heroUrl: null,
      signupOpen: false,
      serverBaseUrl: "",
    });
    expect(html).toContain("允许访客自主注册");
    expect(html).toContain("bg-gx-border-strong");
    expect(html).not.toMatch(/relative h-5 w-9 rounded-full[^"]*bg-gx-accent/);
  });
});

describe("双保险：非 owner / 探针未回 → return null", () => {
  it("isOwner=false 渲染空串，不泄露任何品牌配置文案", () => {
    ownerState = { isOwner: false, isLoading: false };
    const html = render({
      productName: "星表私有云",
      copyright: "© x",
      heroUrl: "/u/h.png",
      signupOpen: true,
      serverBaseUrl: "https://gx.example.com",
    });
    expect(html).toBe("");
    expect(html).not.toContain("产品显示名称");
    expect(html).not.toContain("允许访客自主注册");
  });

  it("isLoading=true（角色探针未回）同样渲染空串，避免闪现", () => {
    ownerState = { isOwner: false, isLoading: true };
    expect(render()).toBe("");
  });
});
