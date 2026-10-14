// 品牌外观配置契约（0.2.4-rc）：全站产品名 / 版权串 / 登录广告图后台可自定义。
//
// 存储口径（后端 app_settings KV，零迁移）：
//   branding.product_name —— 缺行/空串时回退默认产品名「构想工作台」；
//   branding.copyright    —— 原始串，空串表示前端不渲染版权；支持 {year} 占位；
//   branding.login_hero   —— 仅存文件名（hero.jpg|hero.png|hero.webp），空串=前端内置默认图。
// DTO 只暴露读模型：heroUrl 由后端拼公开通道 URL（带 ?v=<updatedAt epoch> 破 immutable 缓存）。

/** 品牌外观读模型（匿名登录页与管理员配置页共用同一形状）。 */
export interface BrandingConfigDTO {
  /** 回退后永不为空：未配置时为默认产品名。 */
  productName: string;
  /** 原始版权串，可空串；空串=前端不渲染；{year} 由前端按当前年份替换。 */
  copyright: string;
  /** null=用前端内置默认图；否则为 /uploads/branding/<file>?v=<epoch>。 */
  heroUrl: string | null;
}

/** PATCH /api/admin/branding 请求体：仅允许两键，均可选，但至少提供一键。 */
export interface BrandingUpdateInput {
  productName?: string;
  copyright?: string;
}

/** 长度上限（前后端共用单一真源；超出由调用方拒绝，不做截断）。 */
export const BRANDING_LIMITS = {
  /** 产品名 trim 后 1..30 字符。 */
  productNameMax: 30,
  /** 版权串 0..120 字符（允许空串=不展示版权）。 */
  copyrightMax: 120,
} as const;
