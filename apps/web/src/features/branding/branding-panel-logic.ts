// 品牌外观设置面板（#754）的纯函数：上传前校验与保存载荷构造。
// 零依赖（不引 react / UI 组件），node 环境直接单测；与后端 routes/branding.ts 口径对齐。

import { BRANDING_LIMITS } from "@gx/shared-types";
import { DEFAULT_BRANDING } from "./branding-text";

/** 广告图允许的 MIME（= 后端 HERO_TYPES 的 jpg/png/webp，明确不收 gif）。 */
export const HERO_ACCEPTED_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** 广告图大小上限 5MB（= 后端 HERO_MAX_BYTES，本地先拦避免一次必败往返）。 */
export const HERO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 广告图上传前本地拦截：类型非 jpg/png/webp 或体积 >5MB 返回错误文案；合法返回 null。
 */
export function validateHeroFile(file: {
  type: string;
  size: number;
}): string | null {
  if (!HERO_ACCEPTED_TYPES.has(file.type))
    return "仅支持 JPG / PNG / WebP 格式";
  if (file.size > HERO_MAX_BYTES) return "广告图不能超过 5MB";
  return null;
}

/**
 * 文本保存前校验：产品名超长 / 版权超长返回错误文案；通过返回 null。
 * 产品名允许空串（空串在 buildBrandingPatch 内映射为默认名），故此处不查非空。
 */
export function validateBrandingText(
  productNameInput: string,
  copyright: string,
): string | null {
  if (productNameInput.trim().length > BRANDING_LIMITS.productNameMax) {
    return `产品名不能超过 ${BRANDING_LIMITS.productNameMax} 字符`;
  }
  if (copyright.length > BRANDING_LIMITS.copyrightMax) {
    return `版权信息不能超过 ${BRANDING_LIMITS.copyrightMax} 字符`;
  }
  return null;
}

/**
 * 文本保存载荷：产品名走 trim；后端 PATCH 不接受空产品名（zod min(1)），
 * 留空语义 = 回退默认名，故空串写回 DEFAULT_BRANDING.productName。版权原样（允许空串）。
 */
export function buildBrandingPatch(
  productNameInput: string,
  copyright: string,
) {
  const trimmedName = productNameInput.trim();
  return {
    productName: trimmedName || DEFAULT_BRANDING.productName,
    copyright,
  };
}
