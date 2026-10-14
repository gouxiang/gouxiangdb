// 品牌外观设置面板纯函数（#754）：上传前校验、文本校验、保存载荷。
// 口径必须与后端 apps/api/src/routes/branding.ts（HERO_TYPES/HERO_MAX_BYTES/patchSchema）对齐。
import { describe, it, expect } from "vitest";
import {
  HERO_MAX_BYTES,
  buildBrandingPatch,
  validateBrandingText,
  validateHeroFile,
} from "./branding-panel-logic";
import { BRANDING_LIMITS } from "@gx/shared-types";

const MB = 1024 * 1024;

describe("validateHeroFile（广告图上传前拦截）", () => {
  it("jpg/png/webp 且不超过 5MB → 通过", () => {
    expect(
      validateHeroFile({ type: "image/jpeg", size: HERO_MAX_BYTES }),
    ).toBeNull();
    expect(validateHeroFile({ type: "image/png", size: 1 })).toBeNull();
    expect(validateHeroFile({ type: "image/webp", size: 4.9 * MB })).toBeNull();
  });

  it("边界：恰好 5MB 通过，超出 1 字节拒绝", () => {
    expect(validateHeroFile({ type: "image/png", size: 5 * MB })).toBeNull();
    expect(validateHeroFile({ type: "image/png", size: 5 * MB + 1 })).toBe(
      "广告图不能超过 5MB",
    );
  });

  it("gif 与非图片类型拒绝（后端明确不收 gif）", () => {
    expect(validateHeroFile({ type: "image/gif", size: 10 })).toBe(
      "仅支持 JPG / PNG / WebP 格式",
    );
    expect(
      validateHeroFile({ type: "application/octet-stream", size: 10 }),
    ).toBe("仅支持 JPG / PNG / WebP 格式");
    expect(validateHeroFile({ type: "", size: 10 })).toBe(
      "仅支持 JPG / PNG / WebP 格式",
    );
  });
});

describe("validateBrandingText（保存前长度校验）", () => {
  it("合法（含空产品名、空版权）→ 通过", () => {
    expect(validateBrandingText("", "")).toBeNull();
    expect(validateBrandingText("构想工作台", "© {year} 构想科技")).toBeNull();
  });

  it("产品名按 trim 后长度判超长（纯空格不在这里拦，而映射为默认名）", () => {
    const max = BRANDING_LIMITS.productNameMax;
    expect(validateBrandingText("构".repeat(max), "")).toBeNull();
    expect(validateBrandingText("构".repeat(max + 1), "")).toBe(
      `产品名不能超过 ${max} 字符`,
    );
    // 两端空格不计入长度，与后端 z.trim() 同口径
    expect(validateBrandingText(` ${"构".repeat(max)} `, "")).toBeNull();
  });

  it("版权超过 120 字符拒绝", () => {
    const max = BRANDING_LIMITS.copyrightMax;
    expect(validateBrandingText("名", "字".repeat(max))).toBeNull();
    expect(validateBrandingText("名", "字".repeat(max + 1))).toBe(
      `版权信息不能超过 ${max} 字符`,
    );
  });
});

describe("buildBrandingPatch（保存载荷：留空回退默认名）", () => {
  it("产品名 trim 透传；版权原样透传（空串=不显示版权）", () => {
    expect(buildBrandingPatch("  我的工作台 ", "© 2026")).toEqual({
      productName: "我的工作台",
      copyright: "© 2026",
    });
    expect(buildBrandingPatch("名", "")).toEqual({
      productName: "名",
      copyright: "",
    });
  });

  it("产品名留空（含纯空格）→ 写回默认名（后端 PATCH zod min(1) 不接受空串）", () => {
    expect(buildBrandingPatch("", "© x").productName).toBe("构想工作台");
    expect(buildBrandingPatch("   ", "© x").productName).toBe("构想工作台");
  });
});
