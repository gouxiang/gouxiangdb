// apps/api/src/middleware/secureHeaders.ts
// 安全响应头：直接用 Hono 自带 hono/secure-headers（零新增运行时依赖，D7：不引 helmet）。
// - CSP M0 不 enforce（前端有内联/画板，贸然 CSP 易炸），由 Caddy 侧补基础头、后续再 report-only。
// - HSTS 不在应用层发（应用在 Caddy 的 HTTP 反代之后，TLS 由 Caddy 终结并给 HSTS）。
// - X-Frame-Options 默认显式 DENY；唯一例外是飞牛 fnOS fpk（见下）。

import { secureHeaders } from "hono/secure-headers";
import type { MiddlewareHandler } from "hono";

// 飞牛 fnOS fpk 改为「独立端口服务」入口后，桌面门户（http://NAS:5666）用【跨源 iframe】
// 嵌入应用自己的端口（http://NAS:3001，见 deploy/fnos/gouxiangdb/app/ui/config 的
// "type":"iframe" + "port":"${wizard_port}"）。X-Frame-Options 只接受 DENY/SAMEORIGIN，
// 二者都会拦跨源 iframe → 门户点开即白屏。飞牛官方端口服务本就「与 NAS 登录态无关、面向独立
// 服务/外网」，故仅在 GX_DEPLOY_CHANNEL=fnos-fpk（cmd/main 显式导出）时【完全不发】该头；
// 其余部署（Caddy 裸机 / Docker / macOS 桌面壳）维持 DENY，点击劫持防护不降级。
const IS_FNOS_FPK = process.env.GX_DEPLOY_CHANNEL?.trim() === "fnos-fpk";

export const secureHeadersMiddleware: MiddlewareHandler = secureHeaders({
  // Hono 4.13.5 的 d.ts 把 CSP 选项标成必填对象、漏了 false 重载，但运行时
  // `if (options.contentSecurityPolicy)` 对 false 显式跳过（已实测不发 CSP 头）。
  // @ts-expect-error 见上行：类型声明缺陷，运行时支持 false 以关闭 CSP
  contentSecurityPolicy: false,
  strictTransportSecurity: false,
  // false 在 Hono 运行时被 getFilteredHeaders 过滤（falsy 不发该头），且类型上合法
  //（overridableHeader = boolean | string）。
  xFrameOptions: IS_FNOS_FPK ? false : "DENY",
  xContentTypeOptions: "nosniff",
  referrerPolicy: "no-referrer",
  xDnsPrefetchControl: "off",
  crossOriginResourcePolicy: "same-origin",
  crossOriginOpenerPolicy: "same-origin",
});
