// apps/api/src/middleware/secureHeaders.ts
// 安全响应头：直接用 Hono 自带 hono/secure-headers（零新增运行时依赖，D7：不引 helmet）。
// - CSP M0 不 enforce（前端有内联/画板，贸然 CSP 易炸），由 Caddy 侧补基础头、后续再 report-only。
// - HSTS 不在应用层发（应用在 Caddy 的 HTTP 反代之后，TLS 由 Caddy 终结并给 HSTS）。
// - X-Frame-Options 显式 DENY；其余采用 Hono 安全默认。

import { secureHeaders } from "hono/secure-headers";
import type { MiddlewareHandler } from "hono";

export const secureHeadersMiddleware: MiddlewareHandler = secureHeaders({
  // Hono 4.13.5 的 d.ts 把 CSP 选项标成必填对象、漏了 false 重载，但运行时
  // `if (options.contentSecurityPolicy)` 对 false 显式跳过（已实测不发 CSP 头）。
  // @ts-expect-error 见上行：类型声明缺陷，运行时支持 false 以关闭 CSP
  contentSecurityPolicy: false,
  strictTransportSecurity: false,
  xFrameOptions: "DENY",
  xContentTypeOptions: "nosniff",
  referrerPolicy: "no-referrer",
  xDnsPrefetchControl: "off",
  crossOriginResourcePolicy: "same-origin",
  crossOriginOpenerPolicy: "same-origin",
});
