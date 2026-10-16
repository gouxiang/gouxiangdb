// 登录与外观配置契约（0.2.4 起；0.2.5 增 serverBaseUrl）：全站产品名 / 版权串 / 登录广告图 /
// 访客自主注册开关 / 服务器对外访问网址，后台可自定义。
//
// 存储口径（后端 app_settings KV，零迁移）：
//   branding.product_name     —— 缺行/空串时回退默认产品名「构想工作台」；
//   branding.copyright        —— 原始串，空串表示前端不渲染版权；支持 {year} 占位；
//   branding.login_hero       —— 仅存文件名（hero.jpg|hero.png|hero.webp），空串=前端内置默认图；
//   auth.public_signup        —— "on"=允许访客在登录页自主注册；缺行/其它值=关闭。
//   branding.server_base_url  —— 管理员手填的「对外可访问网址」（0.2.5），空串=未设置（不启用）。
//                                仅用于在多地址环境（同时有内网 IP 与反代域名）下对外展示/复制
//                                正确的外网网址；声明性字段，不改服务监听、不做重定向。
//
// 自主注册有效态（后端单一判定，见 apps/api configSignup + branding store）：
//   signupOpen = 环境变量 GX_ALLOW_PUBLIC_SIGNUP 显式开放（运维强制旁路）OR KV auth.public_signup="on"。
//   两者皆缺（全新/升级实例的默认）= 关闭，行为与历史版本完全一致；空库首账号自举永远放行，不受此限。
// DTO 只暴露读模型：heroUrl 由后端拼公开通道 URL（带 ?v=<updatedAt epoch> 破 immutable 缓存）。

/** 登录与外观读模型（匿名登录页与管理员配置页共用同一形状）。 */
export interface BrandingConfigDTO {
  /** 回退后永不为空：未配置时为默认产品名。 */
  productName: string;
  /** 原始版权串，可空串；空串=前端不渲染；{year} 由前端按当前年份替换。 */
  copyright: string;
  /** null=用前端内置默认图；否则为 /uploads/branding/<file>?v=<epoch>。 */
  heroUrl: string | null;
  /**
   * 访客自主注册是否有效开放（env GX_ALLOW_PUBLIC_SIGNUP 强制开 OR 后台开关 on）。
   * 登录页 bootstrap-status 与管理员配置读同一判定；默认 false。非敏感状态（本就对匿名公开）。
   */
  signupOpen: boolean;
  /**
   * 管理员手填的「服务器对外访问网址」（0.2.5），已规范化（去尾斜杠）。
   * 空串=未设置：调用方在需要对外网址时回退到当前页面来源/自动探测，不强制任何行为。
   * 语义是**声明性**的：只用于对外展示与生成可复制的外网网址，不改服务监听、不做重定向。
   */
  serverBaseUrl: string;
}

/**
 * PATCH /api/admin/branding 请求体：产品名 / 版权 / 自主注册开关 / 对外访问网址，均可选，
 * 但至少提供一键。signupOpen 与品牌外观放在同一设置处（产品负责人定案）；存 app_settings，零迁移。
 */
export interface BrandingUpdateInput {
  productName?: string;
  copyright?: string;
  signupOpen?: boolean;
  /** 传空串=清空（恢复未设置/自动）；非空须为合法 http(s) 网址，否则后端 400。 */
  serverBaseUrl?: string;
}

/** 长度上限（前后端共用单一真源；超出由调用方拒绝，不做截断）。 */
export const BRANDING_LIMITS = {
  /** 产品名 trim 后 1..30 字符。 */
  productNameMax: 30,
  /** 版权串 0..120 字符（允许空串=不展示版权）。 */
  copyrightMax: 120,
  /** 对外访问网址 0..300 字符（允许空串=未设置；足够覆盖 https://host:port/子路径）。 */
  serverBaseUrlMax: 300,
} as const;

/**
 * 规范化「服务器对外访问网址」（前后端同源纯函数，零依赖，可在浏览器/Node 直接跑）。
 *
 * 规则：
 *   - 入参 trim；空串 → 空串（语义=未设置/恢复自动）；
 *   - 无协议前缀时补 `http://`（允许 "host:3001/app" 这类裸输入，与 node/resolve 口径一致）；
 *   - 仅接受 http/https，拒绝 javascript:/file: 等；host 不能为空/不能含空白；
 *   - host 小写；**路径保留原大小写**（路径可能大小写敏感）；去掉所有尾斜杠；
 *   - 保留端口与子路径；拒绝畸形（含 "//" 的路径段）。
 *
 * @returns 规范化后的 origin(+basePath)；入参非法时返回 null（调用方据此 400 / 前端拦截）。
 *          注意与「空串=合法的清空」区分：空串原样返回 ""，只有非空但非法才返回 null。
 */
export function normalizeServerBaseUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (/\s/.test(trimmed)) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || !/[a-z0-9]/i.test(url.hostname)) return null;

  const scheme = url.protocol === "https:" ? "https" : "http";
  const basePath = url.pathname.replace(/\/+$/, "");
  if (basePath.includes("//")) return null;

  // userinfo（user:pass@）与 query/hash 对外网地址无意义且可能泄漏信息，一律拒绝。
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;

  return `${scheme}://${url.host}${basePath}`;
}
