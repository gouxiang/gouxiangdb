// apps/api/src/index.ts
// API 入口（Hono + Node）：仅做装配 + 监听，业务装配见 app.ts。

// 配置闸门必须是第一行 side-effect import：在任何会牵出 @prisma/client（自动 dotenv）
// 的模块求值之前完成生产环境校验（D3）。
import "./config.js";

import { serve, getRequestListener } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";
import { createApp } from "./app.js";

const { app, webRoot } = createApp();

const port = config.port;

function startTcp(): void {
  serve({ fetch: app.fetch, port }, () => {
    console.log(`[GouXiangDB API] http://localhost:${port}`);
  });
}

function startUnixSocket(socketPath: string): void {
  // 父目录可能不存在（临时目录由编排方挂载）；递归创建，不强制绝对路径（本地可用相对临时路径）。
  const parent = path.dirname(path.resolve(socketPath));
  fs.mkdirSync(parent, { recursive: true });
  // 上一进程异常退出会残留 socket 文件，不删则 EADDRINUSE。
  fs.rmSync(socketPath, { force: true });

  const server: Server = createServer(getRequestListener(app.fetch));
  server.listen(socketPath, () => {
    // 0660：同组（网关运行账户）可读写，其他账户不可达。
    try {
      fs.chmodSync(socketPath, 0o660);
    } catch {
      // 某些文件系统不支持 chmod，best-effort。
    }
    const prefixNote = config.basePath ? ` basePath=${config.basePath}` : "";
    const webNote = webRoot ? ` web=${webRoot}` : "";
    console.log(`[GouXiangDB API] unix:${socketPath}${prefixNote}${webNote}`);
  });

  // 优雅关闭：停止接收 → 排空在途请求 → 删除 socket 文件。10s 兜底强退防 keep-alive 悬挂。
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[GouXiangDB API] 收到 ${signal}，开始优雅关闭`);
    const forceTimer = setTimeout(() => process.exit(0), 10_000);
    forceTimer.unref();
    server.close(() => {
      try {
        fs.rmSync(socketPath, { force: true });
      } catch {
        // best-effort
      }
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // 异常退出也尽力清理 socket 文件，避免下次启动残留。
  process.on("exit", () => {
    try {
      fs.rmSync(socketPath, { force: true });
    } catch {
      // best-effort
    }
  });
}

// 仅在直接运行时启动服务（测试里 import app 不应自动起服务）。
if (process.env.GX_NO_LISTEN !== "1") {
  if (config.socketPath) startUnixSocket(config.socketPath);
  else startTcp();
}

export default app;
export { app };
