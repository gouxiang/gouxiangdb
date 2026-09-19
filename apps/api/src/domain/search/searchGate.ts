// 检索总门（GX_M5_SEARCH）的 db 覆盖解析（纯函数 + 运行期读取）。
//
// 为什么需要它：总门原本只能改环境变量再重启，管理员在界面上完全碰不到。本次在 app_settings
// 增加 search.enabled 覆盖键（on/off/inherit），但【不能假装它能热切换一切】——路由在
// routes/v1/index.ts 由启动期的 config.m5Search 静态挂载，运行期改不了挂载态。因此这里把
// 三件事如实分开，交给前端标注，而不是做一个点了没反应的开关：
//   1. 检索接口 /api/v1/search：请求期读覆盖值判定，覆盖即【立即生效】；
//   2. 索引 worker：启动期决定是否 spawn，覆盖值只能【重启后生效】；
//   3. env=off：路由根本没挂载，覆盖键此刻无法启用检索，必须改 GX_M5_SEARCH 并重启。
//
// 纯函数不触网、不写库；loadSearchGate 才读库（带 TTL 缓存，避免每次检索都打主库）。

import type { PrismaClient } from "@prisma/client";
import type { SearchEnabledOverride, SearchGateDTO, SearchGateFlag } from "@gx/shared-types";
import { parseM5SearchFlag } from "../../configM5Search.js";
import { EmbeddingConfigStore } from "./embeddingConfig.js";

export interface SearchGateResolution {
  effective: SearchGateFlag;
  queryAvailable: boolean;
  envGateOff: boolean;
  workerNeedsRestart: boolean;
}

/** 检索总门覆盖键的合法值（白名单；非法值一律按 inherit 处理，不报错）。 */
export function parseSearchEnabledOverride(raw: string | undefined): SearchEnabledOverride {
  const v = raw?.trim().toLowerCase();
  return v === "on" || v === "off" ? v : "inherit";
}

/**
 * 纯解析：env 启动态 + db 覆盖 -> 目标态与各生效面。
 * inherit = 完全跟随环境变量（老库/未配置时的默认行为，零变化）。
 */
export function resolveSearchGate(
  envFlag: SearchGateFlag,
  override: SearchEnabledOverride,
): SearchGateResolution {
  const envGateOff = envFlag === "off";
  const effective: SearchGateFlag = override === "inherit" ? envFlag : override;
  return {
    effective,
    // 路由挂载由 env 决定：未挂载时无论覆盖成什么都不可达。
    queryAvailable: !envGateOff && effective !== "off",
    envGateOff,
    // worker 只在启动期按 env 起（index.ts bootSearchWorker），覆盖值对它恒需重启。
    workerNeedsRestart: true,
  };
}

const GATE_TTL_MS = 10_000;
/** 缓存按 envFlag 分桶：总门三态各异，绝不能让 on 的结论被 shadow 复用。 */
const cache = new Map<SearchGateFlag, { at: number; effective: SearchGateFlag }>();

/** 测试用：清掉 TTL 缓存，避免用例间互相污染。 */
export function resetSearchGateCache(): void {
  cache.clear();
}

/**
 * 运行期读总门目标态（/api/v1/search 用）：db 覆盖优先，10s TTL 缓存避免每次检索打主库。
 * 读失败一律回落 env 态（保守：绝不因一条配置读不出就让检索 500）。
 */
export async function loadSearchGateFlag(
  prisma: PrismaClient,
  jwtSecret: string,
  env: NodeJS.ProcessEnv,
  /** 启动期总门（路由模块传 config.m5Search；service 层传 parseM5SearchFlag(env)）。 */
  envFlag: SearchGateFlag,
): Promise<SearchGateFlag> {
  if (envFlag === "off") return "off"; // 路由未挂载，不必查库
  const now = Date.now();
  const hit = cache.get(envFlag);
  if (hit && now - hit.at < GATE_TTL_MS) return hit.effective;
  let effective: SearchGateFlag = envFlag;
  try {
    const override = await new EmbeddingConfigStore(prisma, jwtSecret).getSearchEnabledOverride();
    effective = resolveSearchGate(envFlag, override).effective;
  } catch {
    effective = envFlag;
  }
  cache.set(envFlag, { at: now, effective });
  return effective;
}

/** 组装给前端的总门描述（GET 配置时调用，不走缓存，管理员要看到刚存进去的值）。 */
export async function buildSearchGate(
  prisma: PrismaClient,
  jwtSecret: string,
  env: NodeJS.ProcessEnv,
): Promise<SearchGateDTO> {
  const envFlag = parseM5SearchFlag(env.GX_M5_SEARCH);
  let override: SearchEnabledOverride = "inherit";
  try {
    override = await new EmbeddingConfigStore(prisma, jwtSecret).getSearchEnabledOverride();
  } catch {
    override = "inherit";
  }
  return { envValue: envFlag, override, ...resolveSearchGate(envFlag, override) };
}
