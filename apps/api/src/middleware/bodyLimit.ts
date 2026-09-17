// apps/api/src/middleware/bodyLimit.ts
// 请求体上限：用 Hono 自带 hono/body-limit（零新增依赖）。
// 全局 JSON 默认 GX_BODY_LIMIT_JSON（1MB）；头像上传 /api/auth/me/avatar 单独放宽到
// GX_BODY_LIMIT_UPLOAD（6MB，对齐业务 5MB + 余量）。M1 附件外置后再按路由细化。
// 超限统一返回 413 与机器码，不放行堆栈。必须在任何 body 解析之前挂载。

import { bodyLimit } from "hono/body-limit";
import type { Context, MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { effectivePath } from "../utils/request-path.js";

function payloadTooLarge(c: Context) {
  return c.json(
    { error: "请求体超过大小限制", code: "PAYLOAD_TOO_LARGE" },
    413,
  );
}

/** /mcp 超限：同 HTTP 413，但机器码按 §6 用 MCP_PAYLOAD_TOO_LARGE（/api 两档仍 PAYLOAD_TOO_LARGE）。 */
function payloadTooLargeMcp(c: Context) {
  return c.json(
    { error: "请求体超过大小限制", code: "MCP_PAYLOAD_TOO_LARGE" },
    413,
  );
}

const jsonLimit = bodyLimit({
  maxSize: config.bodyLimitJsonBytes,
  onError: payloadTooLarge,
});

const uploadLimit = bodyLimit({
  maxSize: config.bodyLimitUploadBytes,
  onError: payloadTooLarge,
});

// M6/S2：/mcp 第三档（默认 11MB，GX_MCP_BODY_LIMIT）。MCP 客户端（SDK/Inspector）单次
// 工具调用可能携带整块文档/画布 JSON，故放宽；**/api 两档语义与 413 行为逐字节不变**（S0 护栏）。
const mcpLimit = bodyLimit({
  maxSize: config.mcpBodyLimitBytes,
  onError: payloadTooLargeMcp,
});

function isAvatarUpload(c: Context): boolean {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    return false;
  }
  return effectivePath(c) === "/api/auth/me/avatar";
}

/** /mcp 精确判定（去 basePath 前缀后比较；不做前缀放宽，避免误伤 /api）。 */
function isMcpPath(c: Context): boolean {
  return effectivePath(c) === "/mcp";
}

// 按请求路径在三档固定阈值间分流（Hono bodyLimit 阈值在创建时固定）。
// 顺序：/mcp 档 -> 头像上传档 -> /api 默认档（互斥精确路径，既有两档行为不变）。
export const bodyLimitDispatch: MiddlewareHandler = (c, next) => {
  if (isMcpPath(c)) return mcpLimit(c, next);
  return isAvatarUpload(c) ? uploadLimit(c, next) : jsonLimit(c, next);
};
