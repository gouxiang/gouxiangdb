// 品牌外观默认值与纯函数（零依赖模块，不触库、不引 Hono）。
//
// 单独成文件的原因：
//   1. domain/update 的纯单测（service/installGuide）无 DB 副作用装配，不能 import 拖带
//      db.js 的 store.ts；默认产品名由此零依赖模块统一供给，避免字面量漂移；
//   2. renderCopyright 与归一化逻辑给前端作同源移植参考；
//   3. BRANDING_KEYS 是 app_settings 存储契约，域层/测试共用同一字面量。

/** 默认产品名：未配置任何品牌 KV、或读取失败时的全站回退值。 */
export const DEFAULT_PRODUCT_NAME = "构想工作台";

/**
 * 品牌外观 + 登录访问策略键（app_settings KV 表的 k；零迁移复用既有表）。
 * 第四键用 auth. 前缀：自主注册是登录/访问策略而非纯品牌外观，仅因产品定案与品牌外观
 * 放在同一设置处才同居此模块；存储上与三键同为 app_settings 行。
 */
export const BRANDING_KEYS = {
  productName: "branding.product_name",
  copyright: "branding.copyright",
  loginHero: "branding.login_hero",
  publicSignup: "auth.public_signup",
} as const;

/**
 * 产品名归一化：trim；空串回退默认名。
 * 注意：超长不在本函数处理——由路由层 zod 校验拒绝（绝不静默截断用户输入）。
 */
export function normalizeProductName(raw: string): string {
  const trimmed = raw.trim();
  return trimmed === "" ? DEFAULT_PRODUCT_NAME : trimmed;
}

/**
 * 版权串渲染：{year} 替换为指定年份（默认当前公历年）。
 * 空串原样返回（语义=前端不渲染版权）；前端可移植同一份逻辑，后端单测锁住行为。
 */
export function renderCopyright(raw: string, year: number = new Date().getFullYear()): string {
  if (raw === "") return "";
  return raw.replaceAll("{year}", String(year));
}
