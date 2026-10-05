// apps/api/src/app.ts
// 应用装配（零监听副作用，便于测试 import）：
//   1) 单一挂载单元 `mount` 承载全部中间件与业务路由（与重构前 index.ts 的顺序/语义一致）；
//   2) webDist 有效时在 mount 末端追加 SPA 静态处理器（在 /api、/healthz、/readyz、/uploads 之后）；
//   3) 外层 app 先挂 config.basePath 前缀副本、再挂根副本——共享同一 mount 实例，
//      因此中间件链、限流桶、路由表都是单例，且 /api/.. 与 /app/gouxiangdb/api/.. 同时可达；
//   4) app 顶层保留 notFound/onError 兜底，未挂前缀的陌生路径行为与现状一致（JSON 404/统一错误信封）。
//
// 挂载顺序关键：必须先挂 basePath 再挂 "/"。实测 Hono 4.13 路由按注册顺序匹配，
// 若先挂根副本，根副本的 SPA GET * 会先吃掉带前缀请求（两个副本共享同一个 catch-all）。

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import fs from "node:fs";
import path from "node:path";

import { auth } from "./auth.js";
import { meAvatar } from "./routes/meAvatar.js";
import { attachments } from "./routes/attachments.js";
import { bases } from "./routes/bases.js";
import { tables } from "./routes/tables.js";
import { fields } from "./routes/fields.js";
import { records } from "./routes/records.js";
import { views } from "./routes/views.js";
import { viewAdmin } from "./routes/viewAdmin.js";
import { viewUserPrefs } from "./routes/viewUserPrefs.js";
import { layoutVersions } from "./routes/layoutVersions.js";
import { tableShares } from "./routes/tableShares.js";
import { linkable } from "./routes/linkable.js";
import { collab } from "./routes/collab.js";
import { kb } from "./routes/kb/index.js";
import { pub } from "./routes/public.js";
import { search } from "./routes/search.js";
import { v1 } from "./routes/v1/index.js";
import { inviteRoutes } from "./routes/v1/authInvite.js";
import { mcpApp } from "./mcp/transport/mcpApp.js";
import { health } from "./routes/health.js";
import { healthz } from "./routes/healthz.js";
import { readyz } from "./routes/readyz.js";
import { errorResponse } from "./guards.js";
import { config } from "./config.js";
import { VERSION } from "./version.js";
import { secureHeadersMiddleware } from "./middleware/secureHeaders.js";
import { bodyLimitDispatch } from "./middleware/bodyLimit.js";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";
import { mustChangePasswordMiddleware } from "./middleware/mustChangePassword.js";
import { benchMetricsMiddleware } from "./ops/benchMetrics.js";
import { createWebStaticMiddleware, resolveWebDist } from "./ops/serveWeb.js";

// 上传文件静态服务：GET /uploads/avatars/<filename>（node:fs 手写，防穿越，与重构前逐字一致）。
const AVATAR_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function createMount(webRoot: string | null): Hono {
  const mount = new Hono();

  mount.use("*", logger());
  // S9 bench 观测（仅 GX_BENCH=on 生效），默认直通零开销。
  mount.use("*", benchMetricsMiddleware);

  const uploadRoot = config.uploadRoot;
  mount.get("/uploads/avatars/:filename", async (c) => {
    const filename = c.req.param("filename");
    // 防路径穿越
    if (!filename || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
      return c.json({ error: "非法文件名" }, 400);
    }
    const filePath = path.join(uploadRoot, "avatars", filename);
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
  const allowedOriginPatterns: RegExp[] = config.corsOriginPatterns;
  mount.use(
    "*",
    cors({
      origin: (origin) => {
        // 同源 / 非浏览器请求（无 Origin）放行
        if (!origin) return "*";
        return allowedOriginPatterns.some((re) => re.test(origin)) ? origin : null;
      },
      credentials: true,
      // X-GX-Token：飞牛 CGI 网关会吞掉带 Authorization 的请求，Web 端改用该头携带同一 JWT。
      allowHeaders: ["Content-Type", "Authorization", "X-GX-Token"],
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  // 安全响应头与请求体上限（必须在业务路由与 body 解析之前）。
  mount.use("*", secureHeadersMiddleware);
  mount.use("*", bodyLimitDispatch);
  // 限流：auth 端点严格 10/60s，其余 /api 兜底 600/60s；健康/上传在选择器内豁免。
  mount.use("*", rateLimitMiddleware);

  // 强制改密闸门：**必须在业务路由之前**挂载，否则 /api 路由已执行完再拦无意义（挂到
  // mount.route("/api", api) 之后时 Hono 按注册顺序先命中业务路由，闸门根本不会执行）。
  // 只拦已登录且 users.mustChangePassword=true 的请求，白名单外的 /api 一律 403；
  // 未登录/坏令牌放行交给各路由自己的 401（详见 middleware/mustChangePassword.ts）。
  mount.use("/api/*", mustChangePasswordMiddleware);

  // 运维健康端点（根级、不鉴权）；/api/health 保留为兼容别名（桌面壳与旧脚本在用）。
  mount.route("/healthz", healthz);
  mount.route("/readyz", readyz);

  // 根路径：
  //  - API-only 部署（webRoot=null，裸机由 Caddy 托管前端）保持历史行为，GET / 返回服务信息 JSON；
  //  - 全栈同进程托管（webRoot 有效，Docker/飞牛）不注册精确 "/"，让给末尾 SPA 静态处理器，
  //    否则 Hono 精确匹配优先，GET / 会被这段 JSON 抢占、前端首页只能在非根路径回退（容器实测发现）。
  if (!webRoot) {
    mount.get("/", (c) =>
      c.json({
        name: "构想工作台 API",
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
  }

  const api = new Hono();
  api.route("/health", health);
  api.route("/auth", auth);
  // 头像上传/删除从 auth.ts 抽出为独立路由，仍挂在 /api/auth/me/avatar 原路径（契约不变）。
  api.route("/auth/me/avatar", meAvatar);
  api.route("/bases", bases);
  api.route("/tables", tables);
  api.route("/fields", fields);
  api.route("/records", records);
  api.route("/views", views);
  // 表单设计器布局版本（同 /api/views 前缀，单独成文件避免 views.ts 超长）。
  // 两次 route("/views") 是 Hono 支持的叠加挂载：子路由路径不重叠（/:viewId 与
  // /:viewId/layout-versions 深度不同），与 tableShares 挂在 /tables 的既有先例一致。
  api.route("/views", layoutVersions);
  // 视图管理员配置层（同 /api/views 前缀，拆出避免 views.ts 超长；路径 /:viewId/admin）。
  api.route("/views", viewAdmin);
  // 视图每用户个性化（同 /api/views 前缀；路径 /:viewId/prefs，任意可见者只写自己的偏好）。
  api.route("/views", viewUserPrefs);
  // 数据表分享链接（同一 /api/tables 前缀，单独成文件避免 tables.ts 超长）
  api.route("/tables", tableShares);
  // 关联插入选择器（后端按 libraryPolicy 过滤可见对象）
  api.route("/linkable", linkable);
  // R2 附件外置：服务端上传/鉴权下载/软删（纯增量，不动存量 base64 附件）。
  api.route("/attachments", attachments);
  // 实时协同：票据与 presence 两个 HTTP 端点（WS 通道在 index.ts 里挂 upgrade）
  api.route("/collab", collab);
  api.route("/kb", kb);
  api.route("/public", pub);
  api.route("/search", search);
  mount.route("/api", api);

  // M2/M3 企业面：/api/v1 与 /api 平级独立实例；两个 flag 任一 on 即挂载，
  // 子路由在 v1/index.ts 内按各自 flag 条件挂载，未启用的子面请求落入 notFound 404。
  // 两 flag 全 off 时整个 /api/v1 不挂载（与未升级一致），旧 /api 不受影响。
  if (config.enterpriseOrg || config.enterpriseNav) {
    // 公开邀请接受（登录前，不要求 ACTIVE）仅组织面启用，挂在受保护 v1 之前；路径不重叠。
    if (config.enterpriseOrg) {
      mount.route("/api/v1/auth/invite", inviteRoutes);
      // M6/S2 鉴权 MCP 服务：Streamable HTTP 无状态直桥（C-5 定稿：与 /api/v1/pats 同受
      // GX_ENTERPRISE_ORG 门控；off 即不挂载 -> 顶层 404）。挂进 mount 即自动获得
      // /mcp 与 {basePath}/mcp 双路径（spike §2.1 实测路径不参与协议）。
      mount.route("/mcp", mcpApp);
    }
    mount.route("/api/v1", v1);
  }

  // Web 静态（SPA）挂最后：仅在 webDist 有效目录含 index.html 时注册；
  // 无效时不注册，未知 GET 路径继续走 app 顶层 JSON 404（API-only 部署与现状一致）。
  if (webRoot) {
    mount.get("*", createWebStaticMiddleware(webRoot));
  }

  return mount;
}

interface CreatedApp {
  app: Hono;
  webRoot: string | null;
}

export function createApp(): CreatedApp {
  const webRoot = resolveWebDist(config.webDist);
  if (!webRoot && config.webDist.trim() !== "") {
    console.warn(
      `[config] GX_WEB_DIST 无效（目录不存在或缺少 index.html）：${config.webDist}；以 API-only 模式启动（不托管前端静态）`,
    );
  }

  const mount = createMount(webRoot);

  const app = new Hono();
  if (config.basePath) app.route(config.basePath, mount);
  app.route("/", mount);

  // 404（增补机器码 NOT_FOUND，保留原 error/path 契约；path 用全路径，带前缀时也能区分）。
  app.notFound((c) => c.json({ error: "接口不存在", code: "NOT_FOUND", path: c.req.path }, 404));

  // 统一错误处理（mount/子路由抛出的错误会冒泡到外层 app 的 onError）。
  app.onError((err, c) => errorResponse(c, err));

  return { app, webRoot };
}
