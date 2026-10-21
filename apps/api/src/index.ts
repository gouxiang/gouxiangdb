// apps/api/src/index.ts
// API 入口（Hono + Node）：仅做装配 + 监听，业务装配见 app.ts。

// 配置闸门必须是第一行 side-effect import：在任何会牵出 @prisma/client（自动 dotenv）
// 的模块求值之前完成生产环境校验（D3）。
import "./config.js";

import { getRequestListener } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";

import { config } from "./config.js";
import { createApp } from "./app.js";
import { prisma } from "./db.js";
import { startSearchWorker, stopSearchWorker } from "./domain/search/workerRuntime.js";
import { startReplicaSync, stopReplicaSync } from "./domain/sync/replicaSyncRuntime.js";
// 协同：WS 通道挂在每个 http.Server 的 upgrade 上，两处 createServer 都要挂（§8-1）。
import { attachCollab, flushAllAndClose } from "./collab/index.js";

/**
 * M5 内嵌索引 worker 的启动依赖（门控在 workerRuntime 内：m5Search!=="on" 或
 * GX_SEARCH_WORKER==="off" 时直接返回 false，零建库/零连接/零主库查询）。
 * 失败只记日志，不影响监听与检索读路径。
 */
function bootSearchWorker(): void {
  void startSearchWorker({
    prisma,
    env: process.env,
    dataDir: config.dataDir,
    appDir: config.appDir,
    jwtSecret: config.jwtSecret,
    m5Search: config.m5Search,
    searchWorker: config.searchWorker,
  });
}

/**
 * beta.2 B2：本机侧车定时同步引擎启动（门控全在 replicaSyncConfig 内）。
 * GX_OFFLINE_REPLICA 未精确开 或 GX_REPLICA_REMOTE_URL 缺省（出厂默认）时 start 直接返回 false：
 * 不建 timer、不建任何 fetch 传输（不发网络）、不查库，既有启动姿态逐字节不变。
 * 失败只记日志，不影响监听与在线读路径（引擎自身已分阶段吞错，这里再兜一层）。
 */
function bootReplicaSync(): void {
  void startReplicaSync({ env: process.env })
    .then((ok) => {
      if (ok) console.log("[GouXiangDB API] 离线副本定时同步引擎已启动");
    })
    .catch((e) => {
      console.warn("[replica-sync] start failed", e);
    });
}

const { app, webRoot } = createApp();

const port = config.port;

function startTcp(): void {
  const server: Server = createServer(getRequestListener(app.fetch));
  attachCollab(server);
  // bindHost 默认 0.0.0.0（与历史一致）；macOS 桌面 App 传 127.0.0.1 仅绑回环（DESIGN-MACOS-APP §6.2）。
  server.listen(port, config.bindHost, () => {
    const hostNote = config.bindHost && config.bindHost !== "0.0.0.0" ? ` host=${config.bindHost}` : "";
    const prefixNote = config.basePath ? ` basePath=${config.basePath}` : "";
    const webNote = webRoot ? ` web=${webRoot}` : "";
    console.log(`[GouXiangDB API] http://localhost:${port}${hostNote}${prefixNote}${webNote}`);
    bootSearchWorker();
    bootReplicaSync();
  });

  // 优雅关闭：停止接收 → 排空在途请求 → 关闭 Prisma/SQLite 连接（释放热 WAL 帧，避免重启/升级
  // 交接窗口里新进程读到未落盘帧）→ 退出。10s 兜底强退防 keep-alive 悬挂。
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[GouXiangDB API] 收到 ${signal}，开始优雅关闭`);
    const forceTimer = setTimeout(() => process.exit(0), 10_000);
    forceTimer.unref();
    // 协同：先落盘所有房间并断开长连接，再 server.close —— 否则 close 的回调会被
    // 在线的 WS 长连接一直阻塞（10s 兜底一到就是硬退，最后一段编辑会丢）。
    void (async () => {
      try {
        await flushAllAndClose();
      } catch (e) {
        console.warn("[collab] flushAllAndClose failed", e);
      }
      server.close(async () => {
        // 先停 worker 再断 Prisma：worker 循环可能正在用 prisma 认领/回写 change_events，
        // 先断连接会让在途那一条抛错并被判 failed（下次启动还得重跑）。
        stopSearchWorker();
        // 同步引擎同理：先停 timer/释放单写者锁（其内部用 prisma 续期），再断连接。
        await stopReplicaSync();
        try {
          await prisma.$disconnect();
        } catch {
          // best-effort：即使 disconnect 异常也必须退出。
        }
        process.exit(0);
      });
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function startUnixSocket(socketPath: string): void {
  // 父目录可能不存在（临时目录由编排方挂载）；递归创建，不强制绝对路径（本地可用相对临时路径）。
  const parent = path.dirname(path.resolve(socketPath));
  fs.mkdirSync(parent, { recursive: true });
  // 上一进程异常退出会残留 socket 文件，不删则 EADDRINUSE。
  fs.rmSync(socketPath, { force: true });

  const server: Server = createServer(getRequestListener(app.fetch));
  attachCollab(server);
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
    bootSearchWorker();
    bootReplicaSync();
  });

  // 优雅关闭：停止接收 → 排空在途请求 → 删除 socket 文件。10s 兜底强退防 keep-alive 悬挂。
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[GouXiangDB API] 收到 ${signal}，开始优雅关闭`);
    const forceTimer = setTimeout(() => process.exit(0), 10_000);
    forceTimer.unref();
    // 同上：协同先 flush 并断开长连接，否则 server.close 会被在线 WS 阻塞。
    void (async () => {
      try {
        await flushAllAndClose();
      } catch (e) {
        console.warn("[collab] flushAllAndClose failed", e);
      }
      server.close(async () => {
        stopSearchWorker(); // 同上：先停 worker 再断 Prisma。
        await stopReplicaSync(); // 同步引擎：先停 timer/释放锁，再断连接。
        try {
          fs.rmSync(socketPath, { force: true });
          await prisma.$disconnect();
        } catch {
          // best-effort
        }
        process.exit(0);
      });
    })();
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
