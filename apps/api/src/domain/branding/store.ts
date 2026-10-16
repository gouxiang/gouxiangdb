// 品牌外观配置域层（0.2.4）：复用 app_settings KV 表，零迁移、零新增依赖。
//
// 四键：
//   branding.product_name  自定义产品名（trim 后非空；缺行/空串 -> 默认产品名）
//   branding.copyright     版权原始串（缺行="；空串=前端不渲染；支持 {year} 占位）
//   branding.login_hero    登录广告图文件名（hero.jpg|hero.png|hero.webp；空串=前端内置默认图）
//   auth.public_signup     访客自主注册开关（"on"=开放；缺行/其它值=关闭；auth. 前缀因为
//                          这是登录/访问策略，只是与品牌外观同处一个后台设置页）
//
// signupOpen 有效态：环境变量 GX_ALLOW_PUBLIC_SIGNUP 显式开放（运维强制旁路）OR KV "on"，
// 见 configSignup.ts 两个纯函数。两者皆缺=关闭（默认，行为与历史一致）；空库首账号
// 自举永远放行，由 auth.ts 单独处理，与本开关无关。
//
// 匿名登录页/顶栏高频读：进程内整体 TTL 缓存（默认 60s），所有写路径事务提交后必须调
// invalidateBrandingCache()，保证 PATCH 后下一次匿名 GET 立即读到新值。
// 任何读取异常都不向调用方抛 500（公开端点 fail-closed 返回默认 DTO）。
//
// 默认值/键名/纯函数在零依赖的 defaults.ts（update 纯单测与前端同源逻辑复用），此处转出
// 保持品牌模块对外只有一个导入入口。

import { normalizeServerBaseUrl, type BrandingConfigDTO } from "@gx/shared-types";
import { publicSignupAllowedByKv, publicSignupOpen } from "../../configSignup.js";
import { prisma, type DbTx } from "../../db.js";
import { BRANDING_KEYS, DEFAULT_PRODUCT_NAME, normalizeProductName } from "./defaults.js";

export { BRANDING_KEYS, DEFAULT_PRODUCT_NAME, normalizeProductName, renderCopyright } from "./defaults.js";

type BrandingClient = DbTx | typeof prisma;

interface CacheEntry {
  value: BrandingConfigDTO;
  at: number;
}

// 进程内整体缓存：匿名读不打库。TTL 可由 GX_BRANDING_CACHE_TTL_MS 覆盖（测试置 0 即旁路）。
const CACHE_TTL_MS = Number(process.env.GX_BRANDING_CACHE_TTL_MS ?? 60_000) || 0;
let cache: CacheEntry | null = null;

/** 失效缓存：所有品牌写路径在事务提交后调用（写后读一致性的唯一保证）。 */
export function invalidateBrandingCache(): void {
  cache = null;
}

/**
 * 由 KV 行组装 DTO（纯函数，updatedAt 仅用于广告图缓存击穿参数）。
 * signupOpen 不在本函数内读 env/DB：有效态（env 强制开 OR KV on）由 getBranding 计算后
 * 作为第二参注入，保持 assemble 是纯函数（rows + 标量 -> DTO，便于单测与缓存一致）。
 */
function assemble(
  rows: Array<{ k: string; v: string; updatedAt: Date }>,
  signupOpen: boolean,
): BrandingConfigDTO {
  const byKey = new Map(rows.map((r) => [r.k, r]));
  const productName = normalizeProductName(byKey.get(BRANDING_KEYS.productName)?.v ?? "");
  const copyright = byKey.get(BRANDING_KEYS.copyright)?.v ?? "";
  const heroRow = byKey.get(BRANDING_KEYS.loginHero);
  const heroFile = (heroRow?.v ?? "").trim();
  const heroUrl = heroRow && heroFile
    ? `/uploads/branding/${heroFile}?v=${heroRow.updatedAt.getTime()}`
    : null;
  // 对外网址：写入时已规范化（路由层），这里只 trim 回显；脏值（历史/手工改库）防御性归一，
  // 非空但非法则回退空串（未设置），绝不把畸形 URL 下发到公开 DTO。
  const rawServerBaseUrl = (byKey.get(BRANDING_KEYS.serverBaseUrl)?.v ?? "").trim();
  const serverBaseUrl = rawServerBaseUrl === "" ? "" : (normalizeServerBaseUrl(rawServerBaseUrl) ?? "");
  return { productName, copyright, heroUrl, signupOpen, serverBaseUrl };
}

/**
 * 默认 DTO（未配置任何 KV 或读取失败时的回退形态）。
 * 无 KV 行时仍尊重 env 强制开放（运维旁路在品牌读取失败时也不能被意外吞掉）；
 * 默认 env 未设 -> signupOpen=false，与历史行为一致。
 */
export function defaultBranding(): BrandingConfigDTO {
  return {
    productName: DEFAULT_PRODUCT_NAME,
    copyright: "",
    heroUrl: null,
    signupOpen: publicSignupOpen(),
    serverBaseUrl: "",
  };
}

/**
 * 读品牌配置（一次 findMany 取四键）。
 * 命中 TTL 缓存时零查询；client 传入事务实例时不使用缓存（事务内需要最新视图）。
 */
export async function getBranding(client?: BrandingClient): Promise<BrandingConfigDTO> {
  if (!client && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  const rows = await (client ?? prisma).appSetting.findMany({
    where: {
      k: {
        in: [
          BRANDING_KEYS.productName,
          BRANDING_KEYS.copyright,
          BRANDING_KEYS.loginHero,
          BRANDING_KEYS.publicSignup,
          BRANDING_KEYS.serverBaseUrl,
        ],
      },
    },
  });
  // env 已显式开放即短路为 true（此时不关心 KV 值）；env 关时 KV 仅认明确 "on"。
  const kvRow = rows.find((r) => r.k === BRANDING_KEYS.publicSignup);
  const signupOpen = publicSignupOpen() || publicSignupAllowedByKv(kvRow?.v);
  const value = assemble(rows, signupOpen);
  if (!client) cache = { value, at: Date.now() };
  return value;
}

/** 写单个 KV（须在 withWriteTx 事务内调用，client 必须是 tx）。空串也照写（版权可清空）。 */
export async function upsertBrandingKeyTx(
  tx: DbTx,
  key: string,
  value: string,
): Promise<void> {
  await tx.appSetting.upsert({ where: { k: key }, create: { k: key, v: value }, update: { v: value } });
}
