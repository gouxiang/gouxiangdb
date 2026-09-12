// apps/api/src/index.ts
// API 入口（Hono + Node）

// 配置闸门必须是第一行 side-effect import：在任何会牵出 @prisma/client（自动 dotenv）
// 的模块求值之前完成生产环境校验（D3）。
import "./config.js";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import fs from "node:fs";
import path from "node:path";

import { auth } from "./auth.js";
import { bases } from "./routes/bases.js";
import { tables } from "./routes/tables.js";
import { fields } from "./routes/fields.js";
import { records } from "./routes/records.js";
import { views } from "./routes/views.js";
import { kb } from "./routes/kb.js";
import { pub } from "./routes/public.js";
import { search } from "./routes/search.js";
import { health } from "./routes/health.js";
import { healthz } from "./routes/healthz.js";
import { readyz } from "./routes/readyz.js";
import { HttpError, errorResponse } from "./guards.js";
import { config } from "./config.js";
import { VERSION } from "./version.js";
import { secureHeadersMiddleware } from "./middleware/secureHeaders.js";
import { bodyLimitDispatch } from "./middleware/bodyLimit.js";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";

const app = new Hono();

app.use("*", logger());

// 上传文件静态服务：GET /uploads/avatars/<filename>（头像等）
// 上传根目录由 config 单一来源解析（GX_DATA_DIR / UPLOAD_ROOT）。
const UPLOAD_ROOT = config.uploadRoot;
const AVATAR_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
app.get("/uploads/avatars/:filename", async (c) => {
  const filename = c.req.param("filename");
  // 防路径穿越
  if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return c.json({ error: "非法文件名" }, 400);
  }
  const filePath = path.join(UPLOAD_ROOT, "avatars", filename);
  if (!fs.existsSync(filePath)) return c.json({ error: "文件不存在" }, 404);
  const ext = path.extname(filename).toLowerCase();
  const mime = AVATAR_MIME[ext] ?? "application/octet-stream";
  const buf = await fs.promises.readFile(filePath);
  return new Response(buf, {
    headers: {
      "Content-Type": mime,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

// CORS：同源请求（无 Origin）放行；跨域仅允许白名单（开发环境 localhost 端口 + 生产 CORS_ORIGIN）。
const ALLOWED_ORIGIN_PATTERNS: RegExp[] = config.corsOriginPatterns;

app.use(
  "*",
  cors({
    origin: (origin) => {
      // 同源 / 非浏览器请求（无 Origin）放行
      if (!origin) return "*";
      return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin)) ? origin : null;
    },
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  }),
);

// 安全响应头与请求体上限（必须在业务路由与 body 解析之前；健康端点已在上方挂载，天然豁免）。
app.use("*", secureHeadersMiddleware);
app.use("*", bodyLimitDispatch);
// 限流：auth 端点严格 10/60s，其余 /api 兜底 600/60s；健康/上传在选择器内豁免。
app.use("*", rateLimitMiddleware);

// 运维健康端点（根级、不鉴权）。放在鉴权/限流（S5b 豁免）之外；
// /api/health 保留为兼容别名（桌面壳与旧脚本在用）。
app.route("/healthz", healthz);
app.route("/readyz", readyz);

app.get("/", (c) =>
  c.json({
    name: "GouXiangDB API",
    version: VERSION,
    endpoints: [
      "/api/health",
      "/api/auth/signup",
      "/api/auth/login",
      "/api/auth/me",
      "/api/bases",
      "/api/tables",
      "/api/fields",
      "/api/records",
      "/api/views",
    ],
  }),
);

const api = new Hono();
api.route("/health", health);
api.route("/auth", auth);
api.route("/bases", bases);
api.route("/tables", tables);
api.route("/fields", fields);
api.route("/records", records);
api.route("/views", views);
api.route("/kb", kb);
api.route("/public", pub);
api.route("/search", search);
app.route("/api", api);

// 404（增补机器码 NOT_FOUND，保留原 error/path 契约）
app.notFound((c) => c.json({ error: "接口不存在", code: "NOT_FOUND", path: c.req.path }, 404));

// 统一错误处理
app.onError((err, c) => {
  if (err instanceof HttpError) return errorResponse(c, err);
  return errorResponse(c, err);
});

const port = config.port;

// 仅在直接运行时启动服务（测试里 import app 不应自动起服务）
if (process.env.GX_NO_LISTEN !== "1") {
  serve({ fetch: app.fetch, port }, () => {
    console.log(`[GouXiangDB API] http://localhost:${port}`);
  });
}

export default app;
export { app };
