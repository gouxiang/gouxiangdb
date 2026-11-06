/**
 * 商业授权总门配置（GX_LICENSE_*）解析纯函数——从 config.ts 拆出（同 configM5Search.ts 先例，
 * 保 config.ts 单文件行数门禁）。仅依赖字符串/数字处理，无 db/Hono/网络副作用，可表驱动单测。
 *
 *   off（默认，含未设置/空串/未知值/大小写不符）= 不起心跳、不出网、零闸门，逐字节同今天；
 *   verify  = 起心跳、UI 全通电，闸门②只提示不收敛；
 *   enforce = 真收敛（闸门①拦第 6 人、闸门②软挂起超额账号）。
 *
 * 严格取值：仅接受 trim 后的精确小写 "verify"/"enforce"；"VERIFY"/"On" 等一律保守回 off，
 * 与 M1/M4/M5 各 flag 的未知值保守默认纪律一致——配置拼错绝不等于默默进入收费态。
 *
 * 生产授权构建（keys.IS_LICENSE_PROD_BUILD，随信任根 keyring 物理换源而置真，见 build.mjs）
 * 额外三条硬约束：
 *   1) 模式下限：最终 mode 永不为 off，env/文件给 off 或非法值都抬到 verify——授权成品永远通电；
 *   2) 热切只升不降旁路：<dataDir>/license.mode 仅接受精确 verify/enforce，off 不被采信
 *      （删文件即回到 env 默认），因此运维可一分钟在 verify/enforce 间热切换且无法用它关授权；
 *   3) 默认地址改为生产授权中心 https://gouxiang.hn.takin.cc（env 仍可显式覆盖）。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { IS_LICENSE_PROD_BUILD } from "./keys.js";

export type LicenseMode = "off" | "verify" | "enforce";

export type LicensePlatform = "desktop" | "fnos" | "docker";

/** 内网 http 白名单默认（仅这些 CIDR 段允许 http 授权地址，其余必须 https）。 */
export const DEFAULT_HTTP_LAN_WHITELIST: readonly RegExp[] = [
  /^http:\/\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/,
];

/** 开发期授权中心默认地址（本机）。 */
export const DEFAULT_LICENSE_URL = "http://127.0.0.1:8787";

/** 生产授权中心正式地址（正式 NAS 域名反代，出口 183.252.182.132/.134）。 */
export const PROD_LICENSE_URL = "https://gouxiang.hn.takin.cc";

/** 模式热切文件名（落在 dataDir 下）；内容仅接受 verify/enforce。 */
export const LICENSE_MODE_FILENAME = "license.mode";

export interface LicenseConfig {
  /** 通电总闸。 */
  mode: LicenseMode;
  /** 可写数据目录（.license 隐藏冗余/加密缓存落点）；由主 config.dataDir 注入。 */
  dataDir: string;
  /** 种子授权地址（持久化地址列表为空时用）；运行时真源在 store 里的 [当前,上一个,内置]。 */
  url: string;
  /** 占席名单短缓存 TTL（毫秒）：闸门②每请求现算但读库结果短缓存，见 seats.ts。 */
  seatTtlMs: number;
  /** 桌面心跳建议间隔（秒）。 */
  intervalDesktopSec: number;
  /** fnos/docker 心跳建议间隔（秒）。 */
  intervalServerSec: number;
  /** 到期检测窗口内心跳间隔（秒）。 */
  detectWindowSec: number;
  /** 单次授权请求超时（毫秒）。 */
  requestTimeoutMs: number;
  /** http 内网白名单（scheme 校验用）。 */
  httpLanWhitelist: RegExp[];
  /** 平台覆盖（缺省自动探测，见 fingerprint.resolvePlatform）。 */
  platformOverride: LicensePlatform | null;
}

export const DEFAULT_LICENSE_CONFIG: LicenseConfig = {
  mode: "off",
  dataDir: ".",
  url: DEFAULT_LICENSE_URL,
  seatTtlMs: 30_000,
  intervalDesktopSec: 86_400,
  intervalServerSec: 21_600,
  detectWindowSec: 60,
  requestTimeoutMs: 10_000,
  httpLanWhitelist: [...DEFAULT_HTTP_LAN_WHITELIST],
  platformOverride: null,
};

/**
 * 纯函数：原始 env 值 -> 三态门。undefined/空白/未知/大小写不符均回 "off"。
 * 与 parseM5SearchFlag 同款严格小写纪律。
 */
export function parseLicenseMode(raw: string | undefined): LicenseMode {
  const v = raw?.trim();
  if (v === "verify" || v === "enforce") return v;
  return "off";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const v = raw?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) return fallback;
  return n;
}

function parsePlatformOverride(raw: string | undefined): LicensePlatform | null {
  const v = raw?.trim();
  if (v === "desktop" || v === "fnos" || v === "docker") return v;
  return null;
}

/**
 * 纯函数：license.mode 文件原始内容 -> verify/enforce/null。
 * 仅接受精确小写两值；off（及空白/未知/大写）一律返回 null＝不采信该文件。
 * 这样热切通道只能在 verify/enforce 间切换，永远无法用它关掉授权。
 */
export function parseModeFile(raw: string | null | undefined): LicenseMode | null {
  const v = raw?.trim();
  if (v === "verify" || v === "enforce") return v;
  return null;
}

/**
 * 纯函数：合成最终模式。
 * 优先级：合法的 license.mode 文件 > GX_LICENSE_MODE（删文件即回到 env 默认）。
 * 生产构建再套下限：合成结果为 off 时抬到 verify——授权成品永不 off。
 */
export function resolveLicenseMode(
  envMode: LicenseMode,
  fileMode: LicenseMode | null,
  prod: boolean,
): LicenseMode {
  const merged = fileMode ?? envMode;
  if (prod && merged === "off") return "verify";
  return merged;
}

/** 读取 <dataDir>/license.mode 原始内容；缺失/不可读返回 null（不抛错，fail-safe）。 */
export function readLicenseModeFile(dataDir: string): string | null {
  try {
    const p = path.join(dataDir, LICENSE_MODE_FILENAME);
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/**
 * 纯函数：env (+license.mode 文件原始内容) -> LicenseConfig。任何非法/越界值都回默认（fail-safe）。
 * GX_LICENSE_URL 仅做 trim，不做 scheme 校验——scheme 校验在地址迁移/请求处按签名信封+白名单执行。
 * dataDir 由主 config 派生后注入（GX_DATA_DIR 或 prod 默认），不在此重复决策。
 * modeFileRaw 由调用方读盘后注入（见 loadLicenseConfig），使本函数保持无 fs 副作用、可表驱动单测。
 */
export function parseLicenseConfig(
  env: NodeJS.ProcessEnv,
  dataDir: string = ".",
  modeFileRaw: string | null = null,
): LicenseConfig {
  const defaultUrl = IS_LICENSE_PROD_BUILD ? PROD_LICENSE_URL : DEFAULT_LICENSE_URL;
  const url = env.GX_LICENSE_URL?.trim() || defaultUrl;
  const customWhitelist = env.HTTP_LAN_WHITELIST?.trim();
  const mode = resolveLicenseMode(
    parseLicenseMode(env.GX_LICENSE_MODE),
    parseModeFile(modeFileRaw),
    IS_LICENSE_PROD_BUILD,
  );
  return {
    mode,
    dataDir,
    url,
    seatTtlMs: parsePositiveInt(env.GX_LICENSE_SEAT_TTL_MS, DEFAULT_LICENSE_CONFIG.seatTtlMs),
    intervalDesktopSec: parsePositiveInt(
      env.GX_LICENSE_INTERVAL_DESKTOP_SEC,
      DEFAULT_LICENSE_CONFIG.intervalDesktopSec,
    ),
    intervalServerSec: parsePositiveInt(
      env.GX_LICENSE_INTERVAL_SERVER_SEC,
      DEFAULT_LICENSE_CONFIG.intervalServerSec,
    ),
    detectWindowSec: parsePositiveInt(
      env.GX_LICENSE_DETECT_WINDOW_SEC,
      DEFAULT_LICENSE_CONFIG.detectWindowSec,
    ),
    requestTimeoutMs: parsePositiveInt(
      env.GX_LICENSE_REQUEST_TIMEOUT_MS,
      DEFAULT_LICENSE_CONFIG.requestTimeoutMs,
    ),
    httpLanWhitelist: customWhitelist
      ? customWhitelist
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => new RegExp(s))
      : [...DEFAULT_HTTP_LAN_WHITELIST],
    platformOverride: parsePlatformOverride(env.GX_LICENSE_PLATFORM ?? env.GX_PACKAGE_TYPE),
  };
}

/**
 * 启动入口用：读 <dataDir>/license.mode（若有）后委托纯函数解析。
 * 读盘失败按无文件处理（null），绝不因热切文件故障影响启动。
 */
export function loadLicenseConfig(env: NodeJS.ProcessEnv, dataDir: string = "."): LicenseConfig {
  return parseLicenseConfig(env, dataDir, readLicenseModeFile(dataDir));
}

/** mode 是否应启动心跳/出网（off 时 start() 必须零副作用返回 false）。 */
export function licenseNetworkActive(mode: LicenseMode): boolean {
  return mode === "verify" || mode === "enforce";
}
