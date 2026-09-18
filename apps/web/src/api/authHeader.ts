// Web 端统一用自定义头 `X-GX-Token` 携带 JWT，而不是标准 `Authorization: Bearer`。
//
// 原因（2026-09-18 飞牛 fnOS 1.2.0604 实测）：
//   飞牛第三方应用只能走 CGI 反代（/cgi/ThirdParty/<app>/index.cgi/），入口由
//   /usr/trim/bin/trim_http_cgi 校验登录态后再执行应用的 index.cgi。该网关会把请求里的
//   `Authorization` 头当作**它自己的 fnOS 令牌**校验：非 fnOS 令牌一律返回
//   `HTTP 200 + "invalid token"` 并把请求吞掉（不转发给应用）。
//   表现：未带令牌的 /api/auth/signup 能穿过，登录后所有带 Authorization 的 XHR 全被拦，
//   接口拿不到数据 → 主界面永久 loading。
//   改用 X-GX-Token 后请求不再触发该校验，可正常转发。
//
// 后端 resolveActiveAuth 同时接受 `Authorization: Bearer <jwt>` 与 `X-GX-Token: <jwt>`
// （后者可带或不带 Bearer 前缀），因此本改动对直连/网关两种部署形态都成立，
// 且不影响 MCP/PAT 等外部客户端继续使用 Authorization。

/** 构造鉴权请求头；无令牌时返回空对象（不产生空头，避免触发网关校验）。 */
export function authHeaders(token?: string | null): Record<string, string> {
  return token ? { "X-GX-Token": token } : {};
}
