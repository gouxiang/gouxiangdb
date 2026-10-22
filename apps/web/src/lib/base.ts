// apps/web/src/lib/base.ts
// 部署子路径（base path）归一与 URL 拼接。
//
// 同一份构建产物需同时跑在：
//   - 裸机 / Docker 根路径：base="/"（import.meta.env.BASE_URL === "/"）
//   - 飞牛 fnOS 统一网关子路径：base="/app/gouxiangdb/"
// 本模块只做纯字符串运算（无 DOM、无依赖），便于单测覆盖。

/**
 * 解析 API 同源前缀。
 *
 * @param rawApiUrl 显式 VITE_API_URL（绝对来源），trim 后非空则优先使用
 * @param viteBase  Vite 注入的 import.meta.env.BASE_URL，形如 "/" 或 "/app/gouxiangdb/"
 * @returns 同源相对前缀（无尾斜杠）：根部署为 ""，子路径为 "/app/gouxiangdb"；
 *          显式绝对来源则原样去尾斜杠（如 "https://host:3001"）
 */
export function resolveApiBase(
  rawApiUrl: string | undefined,
  viteBase: string | undefined,
): string {
  const raw = rawApiUrl?.trim();
  if (raw) {
    // 显式绝对来源（跨域/独立域名）：维持既有能力，仅去掉末尾斜杠。
    return stripTrailingSlash(raw);
  }
  // 未显式指定：回落到部署 base，使请求与页面同源并带网关前缀。
  return stripTrailingSlash(viteBase ?? "/");
}

/** 去掉所有末尾斜杠；根 "/"（或去完后变空）归一为 ""。 */
function stripTrailingSlash(s: string): string {
  const t = s.replace(/\/+$/, "");
  return t;
}

/**
 * 把应用内绝对路径（"/login"、"/api/..."）拼成带部署 base 的同源路径。
 * base="" 时原样返回；自动处理 "/" 分隔，避免双斜杠。
 * 对已是绝对 URL（http(s)://、//、data:、blob:）的资源原样返回，
 * 以便直接包裹来自后端的头像/附件地址而不破坏 data URL。
 */
export function withBase(base: string, path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) return path;
  if (!base) return path;
  if (!path.startsWith("/")) return `${base}/${path}`;
  return `${base}${path}`;
}

/**
 * 判定某个 pathname 是否为「匿名公开分享页」（路由 /s/:token 及其子树
 * /s/:token/t/:tableId、/s/:token/doc/:docId）。
 *
 * 用于 401 拦截器纵深防御：公开页本就免登录，其上任何意外的私有请求 401
 * 都不应把外部访客踢到 /login。注意 /share/:token 是「登录后加入」页，
 * 不属匿名公开，故这里只认 /s/ 段。
 *
 * 纯字符串运算（无 DOM 依赖），兼容子路径部署：base="/app/gouxiangdb" 时
 * pathname "/app/gouxiangdb/s/abc/t/1" 剥前缀后为 "/s/abc/t/1" 仍命中。
 */
export function isPublicSharePathname(pathname: string, base: string): boolean {
  let p = pathname;
  if (base) {
    const b = base.endsWith("/") ? base.slice(0, -1) : base;
    if (b && p.startsWith(b)) p = p.slice(b.length);
  }
  if (!p.startsWith("/")) p = `/${p}`;
  return /^\/s\/[^/]+/.test(p);
}
