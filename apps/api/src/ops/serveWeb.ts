// apps/api/src/ops/serveWeb.ts
// Web 静态托管（SPA）。仅当 config.webDist 指向含 index.html 的真实目录时才注册。
// 设计约束（与 /uploads/avatars 头像处理器同一风格）：
//   - 零新增第三方依赖，node:fs 手写；
//   - 防路径穿越：path.resolve 后结果必须仍在 webDist 内，越权一律 404；
//   - 必须挂在 /api、/healthz、/readyz、/uploads 之后，绝不吃掉 API；
//   - 命中真实文件按扩展名回 Content-Type，/assets/* 强缓存一年（vite 内容哈希）；
//   - 目录/缺失路径回退 index.html（SPA history 路由），index.html 不缓存。
// 本处理器只匹配 GET；非 GET 未命中路径继续走外层 JSON 404（与现状一致）。

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { effectivePath } from "../utils/request-path.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** 校验 webDist：非空、目录存在、内含 index.html。返回绝对路径；无效返回 null。 */
export function resolveWebDist(raw: string): string | null {
  const dir = raw.trim();
  if (!dir) return null;
  const root = path.resolve(dir);
  try {
    const st = fs.statSync(path.join(root, "index.html"));
    if (st.isFile()) return root;
  } catch {
    // 目录或 index.html 不存在
  }
  return null;
}

export function createWebStaticMiddleware(webDist: string): MiddlewareHandler {
  const root = path.resolve(webDist);
  const indexFile = path.join(root, "index.html");

  const serveIndex = async (): Promise<Response> => {
    const html = await fsp.readFile(indexFile);
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // history 路由回退页必须每次协商校验，避免发版后壳页被缓存。
        "Cache-Control": "no-cache",
      },
    });
  };

  return async (c) => {
    // 去掉网关前缀后的逻辑路径（/app/gouxiangdb/x → /x）。
    const eff = effectivePath(c);

    // /api 的任何未命中路径必须保持 JSON 404（契约：{code:"NOT_FOUND"}），
    // 不能被 SPA 回退吞成 200 text/html。
    if (eff === "/api" || eff.startsWith("/api/")) {
      return c.json({ error: "接口不存在", code: "NOT_FOUND", path: c.req.path }, 404);
    }

    // 百分号解码（含 %2e%2e / %2f 等编码形态），解码失败按 404。
    let decoded: string;
    try {
      decoded = decodeURIComponent(eff);
    } catch {
      return c.json({ error: "非法路径", code: "NOT_FOUND", path: c.req.path }, 404);
    }

    // lexical 拼接到 webDist 内并做包含校验：path.resolve("/srv/web", "./../../etc/passwd")
    // 会逃出 root，命中即拒。decoded 以 "/" 开头，前置 "." 使其成为相对片段。
    // 再显式拒绝任何 ".." 段（双重保险：客户端可能在发送前已把 %2e%2e 归一，
    // 也可能保留 %2f 编码，两种形态都要堵）。
    const segments = decoded.split(/[/\\]/);
    if (segments.includes("..")) {
      return c.json({ error: "非法路径", code: "NOT_FOUND", path: c.req.path }, 404);
    }
    const target = path.resolve(root, "." + decoded);
    if (target !== root && !target.startsWith(root + path.sep)) {
      return c.json({ error: "非法路径", code: "NOT_FOUND", path: c.req.path }, 404);
    }

    if (target !== root) {
      const st = await fsp.stat(target).catch(() => null);
      if (st?.isFile()) {
        const buf = await fsp.readFile(target);
        const ext = path.extname(target).toLowerCase();
        const headers = new Headers({
          "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
        });
        // vite 产物 assets/<name>-<hash>.js|css|...，内容哈希文件名可永久强缓存。
        if (decoded.startsWith("/assets/")) {
          headers.set("Cache-Control", "public, max-age=31536000, immutable");
        }
        return new Response(buf, { headers });
      }
      // 目录或不存在的文件路径 → 落到下方 SPA 回退。
    }

    return serveIndex();
  };
}
