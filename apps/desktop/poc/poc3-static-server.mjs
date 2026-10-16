#!/usr/bin/env node
// apps/desktop/scripts/poc3-static-server.mjs
//
// PoC-3 专用：在本机起一个【只绑回环】的零依赖静态文件服务，模拟 Tauri updater 的更新源。
// 仅自测用，不进生产打包矩阵；只服务指定目录下的 latest.json / *.app.tar.gz / *.sig。
//
// 用法：
//   node apps/desktop/scripts/poc3-static-server.mjs --dir <目录> [--port 18080]
//
// 说明：
//   - 只监听 127.0.0.1，不对局域网开放；
//   - 全量 200 回包（本地 loopback，无需 Range/206），带基本 MIME；
//   - 每条 GET 落一行访问日志，便于核对 updater 实际拉取了哪些路径。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const dir = path.resolve(arg("dir", "."));
const port = Number(arg("port", "18080"));
if (!fs.existsSync(dir)) {
  console.error(`[poc3-src] 目录不存在：${dir}`);
  process.exit(2);
}

const MIME = {
  ".json": "application/json",
  ".gz": "application/gzip",
  ".sig": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.join(dir, rel);
  // 防目录穿越：解析后必须仍在 dir 内。
  if (!file.startsWith(dir + path.sep) && file !== dir) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      console.log(`[poc3-src] 404 ${req.method} ${url.pathname}`);
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const ext = file.endsWith(".tar.gz") ? ".gz" : path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": st.size,
    });
    fs.createReadStream(file).pipe(res);
    console.log(`[poc3-src] 200 ${req.method} ${url.pathname} (${st.size} B)`);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[poc3-src] serving ${dir} on http://127.0.0.1:${port}`);
});
