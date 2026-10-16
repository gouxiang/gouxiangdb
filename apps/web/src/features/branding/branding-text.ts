// 品牌外观纯函数与默认占位（0.2.4-rc）。
//
// 本文件零依赖（不引 react / api），方便在 node 环境直接单测：
//   - 版权串的 {year} 占位替换；
//   - 请求失败 / 加载中使用的默认品牌配置（与后端默认同值）。
// 除这里之外，全站不得再出现面向用户的默认产品名字面量。

import type { BrandingConfigDTO } from "@gx/shared-types";

/**
 * 默认品牌配置：与后端缺省回退完全一致（apps/api 品牌存储缺行时返回该值）。
 * 仅用于公开探针加载中 / 失败时的占位，保证任何时刻页面上都有产品名可显示。
 */
export const DEFAULT_BRANDING: BrandingConfigDTO = {
  productName: "构想工作台",
  copyright: "",
  heroUrl: null,
  // 加载/失败占位默认关闭访客自主注册（fail-closed）；有效态由后端计算，前端只透传。
  signupOpen: false,
  // 未设置对外访问网址（空串=不启用，消费方回退当前页面来源/自动探测）。
  serverBaseUrl: "",
};

/**
 * 渲染版权串：
 *   - 空串 → 空串（调用方据此不渲染版权行）；
 *   - 仅替换 `{year}` 占位为指定/当前年份（全部出现处都替换，与后端约定一致）；
 *   - 其它花括号写法（如 `{name}`、单个 `{`）原样保留，不做模板引擎扩展。
 *
 * year 可注入仅为单测确定性；生产调用走 new Date().getFullYear() 默认值。
 */
export function renderCopyright(
  raw: string,
  year: number = new Date().getFullYear(),
): string {
  if (!raw) return "";
  return raw.split("{year}").join(String(year));
}
