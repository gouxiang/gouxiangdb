// 品牌外观设置面板纯函数（#754 返工版）：空名硬拦截、长度校验、保存载荷、广告图拦截。
// 口径与后端 apps/api/src/routes/branding.ts（patchSchema / HERO_TYPES / HERO_MAX_BYTES）对齐。
import { describe, it, expect } from "vitest";
import { BRANDING_LIMITS } from "@gx/shared-types";
import {
  HERO_MAX_BYTES,
  buildBrandingPatch,
  validateBrandingInput,
  validateHeroFile,
} from "./branding-settings-logic";

const MB = 1024 * 1024;

describe("validateBrandingInput（保存前校验）", () => {
  it("产品名空串 / 纯空格 → 硬拦截，并引导点「恢复默认文案」（不做静默映射默认名）", () => {
    expect(validateBrandingInput("", "")).toBe(
      "产品名不能为空；如需恢复默认名称请点「恢复默认文案」",
    );
    expect(validateBrandingInput("   ", "© x")).toBe(
      "产品名不能为空；如需恢复默认名称请点「恢复默认文案」",
    );
  });

  it("合法：非空产品名 + 空版权 / 非空版权均通过（空版权=不展示）", () => {
    expect(validateBrandingInput("构想工作台", "")).toBeNull();
    expect(validateBrandingInput("星表私有云", "© {year} 星表科技")).toBeNull();
  });

  it("产品名按 trim 后长度判超长，边界 30 通过 / 31 拒绝", () => {
    const max = BRANDING_LIMITS.productNameMax;
    expect(validateBrandingInput("构".repeat(max), "")).toBeNull();
    expect(validateBrandingInput(` ${"构".repeat(max)} `, "")).toBeNull();
    expect(validateBrandingInput("构".repeat(max + 1), "")).toBe(
      `产品名不能超过 ${max} 个字符`,
    );
  });

  it("版权按原样长度判超长（不 trim），边界 120 通过 / 121 拒绝", () => {
    const max = BRANDING_LIMITS.copyrightMax;
    expect(validateBrandingInput("名", "字".repeat(max))).toBeNull();
    expect(validateBrandingInput("名", "字".repeat(max + 1))).toBe(
      `版权信息不能超过 ${max} 个字符`,
    );
  });
});

describe("buildBrandingPatch（保存载荷）", () => {
  it("产品名 trim 首尾；版权原样透传（保留排版，空串=不展示）", () => {
    expect(buildBrandingPatch("  我的工作台 ", "© 2026  构想")).toEqual({
      productName: "我的工作台",
      copyright: "© 2026  构想",
    });
    expect(buildBrandingPatch("名", "")).toEqual({
      productName: "名",
      copyright: "",
    });
  });

  it("不兜底空名：空串原样产出（saveText 已先被 validateBrandingInput 拦下，走不到提交）", () => {
    expect(buildBrandingPatch("", "© x").productName).toBe("");
  });
});

describe("对外访问网址（0.2.5，第三参 serverBaseUrl）", () => {
  it("validate：空串/留空通过（=清空恢复自动）；非空合法通过", () => {
    expect(validateBrandingInput("名", "", "")).toBeNull();
    expect(validateBrandingInput("名", "", "   ")).toBeNull();
    expect(validateBrandingInput("名", "", "https://gx.example.com")).toBeNull();
    expect(validateBrandingInput("名", "", "192.168.31.183:5666")).toBeNull();
  });

  it("validate：非空非法（非 http(s)/含空白/userinfo）拦截", () => {
    expect(validateBrandingInput("名", "", "javascript:alert(1)")).toContain("访问网址格式不正确");
    expect(validateBrandingInput("名", "", "https://a b.com")).toContain("访问网址格式不正确");
    expect(validateBrandingInput("名", "", "https://u:p@gx.com")).toContain("访问网址格式不正确");
  });

  it("validate：超长按 BRANDING_LIMITS 拦截", () => {
    const longUrl = `https://${"a".repeat(BRANDING_LIMITS.serverBaseUrlMax)}.com`;
    expect(validateBrandingInput("名", "", longUrl)).toContain("访问网址不能超过");
  });

  it("build：第三参规范化（去尾斜杠/补 http/小写 host），空串保持空串", () => {
    expect(buildBrandingPatch("名", "", "  https://GX.COM/ ")).toEqual({
      productName: "名",
      copyright: "",
      serverBaseUrl: "https://gx.com",
    });
    expect(buildBrandingPatch("名", "", "host:5666/x/")).toEqual({
      productName: "名",
      copyright: "",
      serverBaseUrl: "http://host:5666/x",
    });
    expect(buildBrandingPatch("名", "", "")).toEqual({
      productName: "名",
      copyright: "",
      serverBaseUrl: "",
    });
  });

  it("build：不传第三参时载荷不含 serverBaseUrl 键（两参旧调用形状不变）", () => {
    expect(buildBrandingPatch("名", "© x")).toEqual({
      productName: "名",
      copyright: "© x",
    });
  });
});

describe("validateHeroFile（广告图上传前拦截）", () => {
  it("jpg/png/webp 且不超过 5MB → 通过", () => {
    expect(validateHeroFile({ type: "image/png", size: 1 })).toBeNull();
    expect(validateHeroFile({ type: "image/webp", size: 4.9 * MB })).toBeNull();
  });

  it("边界：恰好 5MB 通过，超出 1 字节拒绝", () => {
    expect(
      validateHeroFile({ type: "image/png", size: HERO_MAX_BYTES }),
    ).toBeNull();
    expect(
      validateHeroFile({ type: "image/png", size: HERO_MAX_BYTES + 1 }),
    ).toBe("图片不能超过 5MB");
  });

  it("gif / 空 MIME / 非图片类型拒绝", () => {
    expect(validateHeroFile({ type: "image/gif", size: 10 })).toBe(
      "仅支持 PNG / JPG / WebP 图片",
    );
    expect(validateHeroFile({ type: "", size: 10 })).toBe(
      "仅支持 PNG / JPG / WebP 图片",
    );
    expect(
      validateHeroFile({ type: "application/octet-stream", size: 10 }),
    ).toBe("仅支持 PNG / JPG / WebP 图片");
  });
});
