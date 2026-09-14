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

const jsonLimit = bodyLimit({
  maxSize: config.bodyLimitJsonBytes,
  onError: payloadTooLarge,
});

const uploadLimit = bodyLimit({
  maxSize: config.bodyLimitUploadBytes,
  onError: payloadTooLarge,
});

function isAvatarUpload(c: Context): boolean {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    return false;
  }
  return effectivePath(c) === "/api/auth/me/avatar";
}

// 按请求路径在两个固定阈值的 body-limit 之间分流（Hono bodyLimit 阈值在创建时固定）。
export const bodyLimitDispatch: MiddlewareHandler = (c, next) =>
  isAvatarUpload(c) ? uploadLimit(c, next) : jsonLimit(c, next);
