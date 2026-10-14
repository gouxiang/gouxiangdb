// apps/api/src/middleware/bodyLimit.ts
// 请求体上限：用 Hono 自带 hono/body-limit（零新增依赖）。
// 全局 JSON 默认 GX_BODY_LIMIT_JSON（1MB）；上传类端点走独立放宽档：
//   · /api/auth/me/avatar      → GX_BODY_LIMIT_UPLOAD（6MB，对齐业务 5MB + 余量）
//   · /api/attachments         → GX_BODY_LIMIT_ATTACHMENT（40MB，【整包】档）
//   · /api/admin/branding/hero → GX_BODY_LIMIT_UPLOAD（6MB，登录广告图业务上限 5MB）
// 三档互斥精确路径，JSON 档不放宽。超限统一返回 413 与机器码，不放行堆栈。
// 附件的【单文件】校验（默认 20MB）不在本文件，见 domain/attachmentStore.ts。
// 必须在任何 body 解析之前挂载。

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

// 附件上传档（R2 附件外置）：默认 40MB【整包】，与头像档分名，也与该端点单文件
// 校验（20MB）分名——整包大于单文件，一次多传才不会被边界开销挤爆。
const attachmentLimit = bodyLimit({
  maxSize: config.bodyLimitAttachmentBytes,
  onError: payloadTooLarge,
});

// M6/S2：/mcp 第三档（默认 11MB，GX_MCP_BODY_LIMIT）。MCP 客户端（SDK/Inspector）单次
// 工具调用可能携带整块文档/画布 JSON，故放宽；**/api 两档语义与 413 行为逐字节不变**（S0 护栏）。
const mcpLimit = bodyLimit({
  maxSize: config.mcpBodyLimitBytes,
  onError: payloadTooLargeMcp,
});

// 上传类路径 → 档位。全部为**精确路径**判定（不做前缀放宽，避免误伤相邻 /api 路由）；
// 新增上传端点请在此登记，未登记的新端点会落回 1MB JSON 档而静默失败。
const UPLOAD_LIMIT_PATHS: Record<string, "avatar" | "attachment"> = {
  "/api/auth/me/avatar": "avatar",
  "/api/attachments": "attachment",
  // 品牌登录广告图（0.2.4-rc）：业务上限 5MB，复用头像 6MB 档。
  "/api/admin/branding/hero": "avatar",
};

function isUploadPath(c: Context): "avatar" | "attachment" | null {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    return null;
  }
  return UPLOAD_LIMIT_PATHS[effectivePath(c)] ?? null;
}

/** /mcp 精确判定（去 basePath 前缀后比较；不做前缀放宽，避免误伤 /api）。 */
function isMcpPath(c: Context): boolean {
  return effectivePath(c) === "/mcp";
}

// 按请求路径在四档固定阈值间分流（Hono bodyLimit 阈值在创建时固定）。
// 顺序：/mcp 档 -> 上传类档（头像 6MB / 附件整包 40MB）-> /api 默认档（互斥精确路径，
// 既有两档行为不变）。
export const bodyLimitDispatch: MiddlewareHandler = (c, next) => {
  if (isMcpPath(c)) return mcpLimit(c, next);
  const uploadKind = isUploadPath(c);
  if (uploadKind === "attachment") return attachmentLimit(c, next);
  return uploadKind === "avatar" ? uploadLimit(c, next) : jsonLimit(c, next);
};
