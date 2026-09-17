// M6/S2 /mcp 子应用（挂进 app.ts 的 mount，自动获得 /mcp 与 {basePath}/mcp 双路径）。
//
// 中间件序（§4.1）：
//   ① 两段式限流第一段：认证前按 sourceIp 预桶（防未认证打爆）；
//   ② 边缘认证（Bearer PAT，五态 401）
//   ③ 两段式限流第二段：认证后按 pat:<patId> 正式桶
//   ④ 交给无状态 Streamable HTTP 直桥（每请求 new server+transport）
//
// 限流内聚在本子应用（复用 FixedWindowCounter），**全局 selectRule 对 /mcp 仍返回 null**（不改既有规则表）；
// 这是计划 §5.3 定稿：全局只增 bodyLimit 一档，限流不污染全局。
// 门控：/mcp 随 GX_ENTERPRISE_ORG（C-5，off 即不挂载 -> 404）。

import { Hono, type Context } from "hono";
import { config } from "../../config.js";
import { FixedWindowCounter, type RateRule } from "../../middleware/rateLimit.js";
import { sourceIp } from "../../utils/client-ip.js";
import { authenticatePat, type McpAuthFailReason } from "./authenticate.js";
import { handleMcpRequest } from "./streamableHttp.js";

/** 失败原因 -> 对外文案（§4.3：无 Bearer/前缀不符/查不到 三者同口径；revoked/expired/disabled 各自可辨识）。 */
const AUTH_MESSAGE: Record<McpAuthFailReason, string> = {
  missing_bearer: "Unauthorized",
  not_pat_prefix: "Unauthorized",
  unknown_token: "Unauthorized",
  revoked: "Token revoked",
  expired: "Token expired",
  account_disabled: "Account disabled",
};

const counter = new FixedWindowCounter();
/** 每进程一个 MCP 限流桶实例（单实例部署前提，与全局限流同纪律）。 */
export const mcpRateCounter = counter;

function ipRule(): RateRule {
  return { name: "mcp-ip", limit: config.mcpRateIpMax, windowMs: config.mcpRateWindowMs, match: () => true };
}
function patRule(): RateRule {
  return { name: "mcp-pat", limit: config.mcpRatePatMax, windowMs: config.mcpRateWindowMs, match: () => true };
}

function jsonRpcError(c: Context, httpStatus: 401 | 429, code: number, message: string): Response {
  return c.json({ jsonrpc: "2.0", error: { code, message }, id: null }, httpStatus);
}

/** 401：HTTP 层 + WWW-Authenticate + JSON-RPC -32001（id:null）。 */
function unauthorized(c: Context, reason: McpAuthFailReason): Response {
  c.header("WWW-Authenticate", 'Bearer realm="gouxiangdb-mcp"');
  return jsonRpcError(c, 401, -32001, AUTH_MESSAGE[reason]);
}

/** 429：HTTP 层 + Retry-After + X-RateLimit-*（JSON-RPC 外信封，§5.3）。 */
function rateLimited(c: Context, limit: number, remaining: number, retryAfterSec: number): Response {
  c.header("Retry-After", String(retryAfterSec));
  c.header("X-RateLimit-Limit", String(limit));
  c.header("X-RateLimit-Remaining", String(remaining));
  return jsonRpcError(c, 429, -32029, "RATE_LIMITED");
}

export function createMcpApp(): Hono {
  const app = new Hono();
  app.all("/", async (c) => {
    const enabled = config.rateLimitEnabled;
    const now = Date.now();

    // ① 认证前 IP 预桶
    if (enabled) {
      const d = counter.hit(sourceIp(c), ipRule(), now);
      if (!d.allowed) return rateLimited(c, d.limit, d.remaining, d.retryAfterSec);
    }
    // ② 边缘认证（每请求独立，无会话信任）
    const auth = await authenticatePat(c.req.header("Authorization"));
    if (!auth.ok) return unauthorized(c, auth.reason);
    // ③ 认证后 patId 正式桶
    if (enabled) {
      const d = counter.hit(`pat:${auth.subject.patId}`, patRule(), now);
      if (!d.allowed) return rateLimited(c, d.limit, d.remaining, d.retryAfterSec);
    }
    // ④ 直桥（每请求 new server + new transport）
    return handleMcpRequest(c, auth.subject);
  });
  return app;
}

/** app.ts 挂载用单例。 */
export const mcpApp = createMcpApp();
