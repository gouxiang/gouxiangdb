// 品牌域纯函数单测（零依赖 defaults 模块，不触库、不加载 db.js）：
// 产品名归一化 + 版权 {year} 渲染 + 默认值常量 + KV 键契约。
// getBranding 的 KV 组装/缓存失效在 routes/__tests__/branding.test.ts 真库端到端覆盖。

import { describe, expect, it } from "vitest";
import {
  BRANDING_KEYS,
  DEFAULT_PRODUCT_NAME,
  normalizeProductName,
  renderCopyright,
} from "../defaults.js";

describe("normalizeProductName", () => {
  it("trim 首尾空白", () => {
    expect(normalizeProductName("  蓝奏云 ")).toBe("蓝奏云");
    expect(normalizeProductName("\t构想\n")).toBe("构想");
  });
  it("空串/全空白回退默认产品名", () => {
    expect(normalizeProductName("")).toBe(DEFAULT_PRODUCT_NAME);
    expect(normalizeProductName("   ")).toBe(DEFAULT_PRODUCT_NAME);
    expect(DEFAULT_PRODUCT_NAME).toBe("构想工作台");
  });
  it("不截断超长（超长拒绝是路由层 zod 的职责）", () => {
    const long = "名".repeat(31);
    expect(normalizeProductName(long)).toBe(long);
  });
});

describe("renderCopyright", () => {
  it("{year} 替换为传入年份（默认当前公历年）", () => {
    expect(renderCopyright("© {year} 蓝奏云", 2026)).toBe("© 2026 蓝奏云");
    expect(renderCopyright("{year}-{year}", 2030)).toBe("2030-2030");
    expect(renderCopyright("© {year} 蓝奏云")).toBe(`© ${new Date().getFullYear()} 蓝奏云`);
  });
  it("空串原样返回（语义=前端不渲染版权）", () => {
    expect(renderCopyright("", 2026)).toBe("");
  });
  it("无占位符的串原样返回", () => {
    expect(renderCopyright("保留所有权利", 2026)).toBe("保留所有权利");
  });
});

describe("BRANDING_KEYS", () => {
  it("五键固定（app_settings 存储契约；注册开关用 auth. 前缀；对外网址 0.2.5 增）", () => {
    expect(BRANDING_KEYS).toEqual({
      productName: "branding.product_name",
      copyright: "branding.copyright",
      loginHero: "branding.login_hero",
      publicSignup: "auth.public_signup",
      serverBaseUrl: "branding.server_base_url",
    });
  });
});
