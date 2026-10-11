// apps/api/src/configUpdate.ts
// 应用更新机制（第 2 章）配置解析纯函数——从 config.ts 拆出（同 configM5Search/configSignup
// 先例，保 config.ts 单文件行数门禁）。只依赖 node 的 URL，无 db/Hono/网络副作用，可表驱动单测。
//
// 设计唯一依据：docs/design/2026-10-app-update/DESIGN.md §5.3 配置项表。
// 全部为【可选部署适配】，不进生产 fail-closed 必填校验（同 socketPath/basePath/webDist 纪律）：
// 一项不配也能启动，且「不配任何 GX_UPDATE_*」时本机制对外完全不可见（路由默认虽 on，
// 但前端分区/后端行为不影响任何既有功能；真正的零变化回归在路由挂载门验证）。
//
// 解析纪律（与全仓 flag 一致）：
//   - 布尔/枚举只认精确小写，拼写/大写保守回默认并记 warning（绝不因配错退出进程）；
//   - 数值只认正整数毫秒，非法回默认并记 warning；
//   - URL/Repo 结构级校验，非法回默认并记 warning；
//   - token 只做 trim 原样保留，绝不进 warning / 日志 / 错误信息。

/** 更新源种类（§5.3 GX_UPDATE_SOURCE）。 */
export type UpdateSourceKind = "gitea" | "static";

/** 更新机制解析后的配置（不可变快照，由 config.ts 在启动期构建一次）。 */
export interface UpdateConfig {
  /** 总开关：仅精确小写 "off" 关闭，默认 on（零轮询，唯一出网在 owner 手动点击瞬间）。 */
  enabled: boolean;
  source: UpdateSourceKind;
  /** Gitea 站点根，不带尾斜杠。 */
  giteaBaseUrl: string;
  /** owner/repo。 */
  repo: string;
  /** static 源清单直链，或 gitea 源下对清单地址的强制覆盖（内网镜像）；空=不覆盖。 */
  manifestUrl: string;
  /** 更新源只读凭证；永不下发浏览器、不写审计明文、不进日志。空=未配置。 */
  token: string;
  /** 通道识别显式覆盖原值（GX_UPDATE_CHANNEL）；合法性由 channel 探测按注册表裁决，这里只 trim。 */
  channelOverride: string;
  /** 仅精确小写 "on" 才纳入预发布 release，默认 false。 */
  allowPrerelease: boolean;
  /** 清单/元数据请求超时（ms），默认 8000。 */
  timeoutMs: number;
  /** 下载代理【空闲】超时（ms，非总时长），默认 30000。 */
  downloadIdleTimeoutMs: number;
  /** 清单进程内缓存 TTL（ms），默认 300000（5 分钟）。 */
  cacheTtlMs: number;
  /** 下载票据有效期（ms），默认 120000（2 分钟）。 */
  ticketTtlMs: number;
}

export const UPDATE_DEFAULTS = {
  source: "gitea",
  giteaBaseUrl: "https://gitea0.hn.takin.cc",
  repo: "GouXiang/gouxiangdb",
  timeoutMs: 8000,
  downloadIdleTimeoutMs: 30000,
  cacheTtlMs: 300000,
  ticketTtlMs: 120000,
} as const;

/**
 * 总开关：默认 on，仅 trim 后精确小写 "off" 关闭。
 * 刻意不做 toLowerCase：与「精确小写」口径一致，"OFF"/"Off" 不关闭（按 on 处理）。
 */
export function parseUpdateEnabled(raw: string | undefined): boolean {
  return raw?.trim() !== "off";
}

/** 源种类：仅精确小写 gitea/static，其余（含未设）回 gitea。warning 由调用方按是否「显式但非法」决定。 */
export function parseUpdateSource(raw: string | undefined): UpdateSourceKind {
  const v = raw?.trim();
  if (v === "static") return "static";
  return "gitea";
}

/** 预发布门：仅精确小写 "on" 放行。 */
export function parseAllowPrerelease(raw: string | undefined): boolean {
  return raw?.trim() === "on";
}

/**
 * 正整数毫秒解析；未设/空白/非整数/≤0 回退默认。
 * @returns 值 + 是否采用了回退（供调用方记 warning）。
 */
export function parsePositiveIntMs(
  raw: string | undefined,
  fallback: number,
): { value: number; fellBack: boolean } {
  if (raw === undefined || raw.trim() === "") return { value: fallback, fellBack: false };
  const t = raw.trim();
  // 只接受十进制数字串，杜绝 Number("0x10")=16 / Number("1e3")=1000 的隐式进制/指数解析。
  if (!/^\d+$/.test(t)) return { value: fallback, fellBack: true };
  const n = Number(t);
  if (!Number.isInteger(n) || n <= 0) return { value: fallback, fellBack: true };
  return { value: n, fellBack: false };
}

/**
 * Gitea 站点根归一：只接受 http(s)、去掉全部尾斜杠；非法回默认。
 * @returns 值 + 非法时的 warning（合法/未设时 warning=null）。
 */
export function parseGiteaBaseUrl(
  raw: string | undefined,
): { value: string; warning: string | null } {
  const t = raw?.trim();
  if (!t) return { value: UPDATE_DEFAULTS.giteaBaseUrl, warning: null };
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return {
      value: UPDATE_DEFAULTS.giteaBaseUrl,
      warning: `GX_UPDATE_GITEA_BASE_URL 不是合法 URL（「${t}」），已回退默认 ${UPDATE_DEFAULTS.giteaBaseUrl}`,
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return {
      value: UPDATE_DEFAULTS.giteaBaseUrl,
      warning: `GX_UPDATE_GITEA_BASE_URL 仅允许 http/https（当前 ${url.protocol}），已回退默认`,
    };
  }
  return { value: t.replace(/\/+$/, ""), warning: null };
}

/**
 * repo 归一：要求 owner/repo 形态（两段、各非空、不含空白/额外斜杠，字母数字与 ._- ）；
 * 非法回默认并 warn。
 */
export function parseRepo(raw: string | undefined): { value: string; warning: string | null } {
  const t = raw?.trim();
  if (!t) return { value: UPDATE_DEFAULTS.repo, warning: null };
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(t);
  if (!m) {
    return {
      value: UPDATE_DEFAULTS.repo,
      warning: `GX_UPDATE_REPO 必须形如 owner/repo（当前「${t}」），已回退默认 ${UPDATE_DEFAULTS.repo}`,
    };
  }
  return { value: `${m[1]}/${m[2]}`, warning: null };
}

/**
 * 纯函数：env → 更新配置 + 非致命问题列表。warning 只含变量名/取值形态，
 * 【绝不】包含 token。
 */
export function parseUpdateConfig(env: NodeJS.ProcessEnv = process.env): {
  config: UpdateConfig;
  warnings: string[];
} {
  const warnings: string[] = [];

  // 显式配了源但既不是 gitea 也不是 static → 回默认并 warn（未设不 warn）。
  const sourceRaw = env.GX_UPDATE_SOURCE?.trim();
  if (sourceRaw !== undefined && sourceRaw !== "" && sourceRaw !== "gitea" && sourceRaw !== "static") {
    warnings.push(
      `GX_UPDATE_SOURCE 仅支持 gitea/static（当前「${sourceRaw}」），已回退默认 gitea`,
    );
  }
  const source = parseUpdateSource(env.GX_UPDATE_SOURCE);

  const base = parseGiteaBaseUrl(env.GX_UPDATE_GITEA_BASE_URL);
  if (base.warning) warnings.push(base.warning);

  const repo = parseRepo(env.GX_UPDATE_REPO);
  if (repo.warning) warnings.push(repo.warning);

  const timeout = parsePositiveIntMs(env.GX_UPDATE_TIMEOUT_MS, UPDATE_DEFAULTS.timeoutMs);
  if (timeout.fellBack) {
    warnings.push(
      `GX_UPDATE_TIMEOUT_MS 必须为正整数毫秒（当前「${env.GX_UPDATE_TIMEOUT_MS}」），已回退默认 ${UPDATE_DEFAULTS.timeoutMs}`,
    );
  }
  const idle = parsePositiveIntMs(
    env.GX_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS,
    UPDATE_DEFAULTS.downloadIdleTimeoutMs,
  );
  if (idle.fellBack) {
    warnings.push(
      `GX_UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS 必须为正整数毫秒，已回退默认 ${UPDATE_DEFAULTS.downloadIdleTimeoutMs}`,
    );
  }
  const cache = parsePositiveIntMs(env.GX_UPDATE_CACHE_TTL_MS, UPDATE_DEFAULTS.cacheTtlMs);
  if (cache.fellBack) {
    warnings.push(
      `GX_UPDATE_CACHE_TTL_MS 必须为正整数毫秒，已回退默认 ${UPDATE_DEFAULTS.cacheTtlMs}`,
    );
  }
  const ticket = parsePositiveIntMs(env.GX_UPDATE_TICKET_TTL_MS, UPDATE_DEFAULTS.ticketTtlMs);
  if (ticket.fellBack) {
    warnings.push(
      `GX_UPDATE_TICKET_TTL_MS 必须为正整数毫秒，已回退默认 ${UPDATE_DEFAULTS.ticketTtlMs}`,
    );
  }

  const config: UpdateConfig = {
    enabled: parseUpdateEnabled(env.GX_UPDATE_ENABLED),
    source,
    giteaBaseUrl: base.value,
    repo: repo.value,
    manifestUrl: env.GX_UPDATE_MANIFEST_URL?.trim() ?? "",
    token: env.GX_UPDATE_TOKEN?.trim() ?? "",
    channelOverride: env.GX_UPDATE_CHANNEL?.trim() ?? "",
    allowPrerelease: parseAllowPrerelease(env.GX_UPDATE_ALLOW_PRERELEASE),
    timeoutMs: timeout.value,
    downloadIdleTimeoutMs: idle.value,
    cacheTtlMs: cache.value,
    ticketTtlMs: ticket.value,
  };

  return { config, warnings };
}
