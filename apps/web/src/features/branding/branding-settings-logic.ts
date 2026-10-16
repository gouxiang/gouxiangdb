// 品牌外观设置面板（#754）的纯函数：保存前文本校验、上传前广告图校验、保存载荷构造。
// 零依赖（不引 react / UI 组件），node 环境直接单测；口径与后端 routes/branding.ts 对齐：
//   - PATCH productName：zod trim().min(1).max(30)，空串后端 400——前端先硬拦空名，
//     绝不做「留空静默映射默认名」（那会绕过管理员的显式意图）；恢复默认走「恢复默认文案」按钮。
//   - PATCH copyright：原样存储 0..120（不 trim，保留用户排版），空串=不展示版权行。
//   - PATCH serverBaseUrl（0.2.5）：空串=清空/恢复自动；非空须是合法 http(s) 网址
//     （normalizeServerBaseUrl，前后端同源），去尾斜杠。
//   - hero：仅 image/jpeg|png|webp，≤5MB。

import { BRANDING_LIMITS, normalizeServerBaseUrl } from "@gx/shared-types";

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
    return "仅支持 PNG / JPG / WebP 图片";
  if (file.size > HERO_MAX_BYTES) return "图片不能超过 5MB";
  return null;
}

/**
 * 文本保存前校验，返回错误文案（用于 toast）；通过返回 null。
 *   - 产品名 trim 后为空 → 硬拦截，并引导用「恢复默认文案」按钮（后端空名会 400）；
 *   - 产品名 trim 后超长 → 按 BRANDING_LIMITS 单一真源提示；
 *   - 版权按原样长度判超长（不 trim）；允许空串（= 不展示）；
 *   - 对外访问网址：非空时必须能规范化为合法 http(s) 网址；空串=清空（合法）。
 */
export function validateBrandingInput(
  productNameInput: string,
  copyright: string,
  serverBaseUrlInput?: string,
): string | null {
  if (!productNameInput.trim()) {
    return "产品名不能为空；如需恢复默认名称请点「恢复默认文案」";
  }
  if (productNameInput.trim().length > BRANDING_LIMITS.productNameMax) {
    return `产品名不能超过 ${BRANDING_LIMITS.productNameMax} 个字符`;
  }
  if (copyright.length > BRANDING_LIMITS.copyrightMax) {
    return `版权信息不能超过 ${BRANDING_LIMITS.copyrightMax} 个字符`;
  }
  if (serverBaseUrlInput !== undefined) {
    if (serverBaseUrlInput.trim().length > BRANDING_LIMITS.serverBaseUrlMax) {
      return `访问网址不能超过 ${BRANDING_LIMITS.serverBaseUrlMax} 个字符`;
    }
    if (normalizeServerBaseUrl(serverBaseUrlInput) === null) {
      return "访问网址格式不正确，请填写 http(s):// 开头的有效网址";
    }
  }
  return null;
}

/**
 * 文本保存载荷：产品名 trim 首尾后提交；版权原样提交（保留用户排版，空串=不展示）；
 * 对外访问网址按 normalizeServerBaseUrl 规范化提交（空串=清空；调用前须已通过校验）。
 * 调用方必须先过 validateBrandingInput——本函数不兜底空名（后端 min(1) 会 400）。
 */
export function buildBrandingPatch(
  productNameInput: string,
  copyright: string,
  serverBaseUrlInput?: string,
): { productName: string; copyright: string; serverBaseUrl?: string } {
  const patch: { productName: string; copyright: string; serverBaseUrl?: string } = {
    productName: productNameInput.trim(),
    copyright,
  };
  if (serverBaseUrlInput !== undefined) {
    // 已校验过，normalize 非 null；空串保持空串。
    patch.serverBaseUrl = normalizeServerBaseUrl(serverBaseUrlInput) ?? "";
  }
  return patch;
}
