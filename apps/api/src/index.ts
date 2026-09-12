// apps/api/src/index.ts
// API 入口（Hono + Node）

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
import { HttpError, errorResponse } from "./guards.js";
import { VERSION } from "./version.js";

const app = new Hono();

app.use("*", logger());

// 上传文件静态服务：GET /uploads/avatars/<filename>（头像等）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.resolve(__dirname, "../uploads");
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
const ALLOWED_ORIGIN_PATTERNS: RegExp[] = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((s) => new RegExp(`^${s.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`))
  : [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

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

// 404
app.notFound((c) => c.json({ error: "接口不存在", path: c.req.path }, 404));

// 统一错误处理
app.onError((err, c) => {
  if (err instanceof HttpError) return errorResponse(c, err);
  return errorResponse(c, err);
});

const port = Number(process.env.PORT ?? 3001);

// 仅在直接运行时启动服务（测试里 import app 不应自动起服务）
if (process.env.GX_NO_LISTEN !== "1") {
  serve({ fetch: app.fetch, port }, () => {
    // eslint-disable-next-line no-console
    console.log(`[GouXiangDB API] http://localhost:${port}`);
  });
}

export default app;
export { app };
