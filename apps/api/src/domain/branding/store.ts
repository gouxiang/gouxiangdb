// 品牌外观配置域层（0.2.4-rc）：复用 app_settings KV 表，零迁移、零新增依赖。
//
// 三键：
//   branding.product_name  自定义产品名（trim 后非空；缺行/空串 -> 默认产品名）
//   branding.copyright     版权原始串（缺行="；空串=前端不渲染；支持 {year} 占位）
//   branding.login_hero    登录广告图文件名（hero.jpg|hero.png|hero.webp；空串=前端内置默认图）
//
// 匿名登录页/顶栏高频读：进程内整体 TTL 缓存（默认 60s），所有写路径事务提交后必须调
// invalidateBrandingCache()，保证 PATCH 后下一次匿名 GET 立即读到新值。
// 任何读取异常都不向调用方抛 500（公开端点 fail-closed 返回默认 DTO）。
//
// 默认值/键名/纯函数在零依赖的 defaults.ts（update 纯单测与前端同源逻辑复用），此处转出
// 保持品牌模块对外只有一个导入入口。

import type { BrandingConfigDTO } from "@gx/shared-types";
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

/** 由 KV 行组装 DTO（纯函数，updatedAt 仅用于广告图缓存击穿参数）。 */
function assemble(rows: Array<{ k: string; v: string; updatedAt: Date }>): BrandingConfigDTO {
  const byKey = new Map(rows.map((r) => [r.k, r]));
  const productName = normalizeProductName(byKey.get(BRANDING_KEYS.productName)?.v ?? "");
  const copyright = byKey.get(BRANDING_KEYS.copyright)?.v ?? "";
  const heroRow = byKey.get(BRANDING_KEYS.loginHero);
  const heroFile = (heroRow?.v ?? "").trim();
  const heroUrl = heroRow && heroFile
    ? `/uploads/branding/${heroFile}?v=${heroRow.updatedAt.getTime()}`
    : null;
  return { productName, copyright, heroUrl };
}

/** 默认 DTO（未配置任何 KV 或读取失败时的回退形态）。 */
export function defaultBranding(): BrandingConfigDTO {
  return { productName: DEFAULT_PRODUCT_NAME, copyright: "", heroUrl: null };
}

/**
 * 读品牌配置（一次 findMany 取三键）。
 * 命中 TTL 缓存时零查询；client 传入事务实例时不使用缓存（事务内需要最新视图）。
 */
export async function getBranding(client?: BrandingClient): Promise<BrandingConfigDTO> {
  if (!client && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  const rows = await (client ?? prisma).appSetting.findMany({
    where: { k: { in: [BRANDING_KEYS.productName, BRANDING_KEYS.copyright, BRANDING_KEYS.loginHero] } },
  });
  const value = assemble(rows);
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
