// apps/api/scripts/bench/server.ts
// M1/S9 压测目标进程生命周期：构建生产 dist → 以独立生产 env 起 node dist/index.js →
// 轮询 /readyz 就绪 → 真实 /api/auth/login 取 JWT → 返回 baseUrl/token/清理函数。
//
// 生产同构铁律：harness 打的是 esbuild 产物（NODE_ENV=production），不是 tsx dev——
// 配置闸门、安全头、错误信封都走真实生产路径。独立 DATABASE_URL/JWT_SECRET/CORS_ORIGIN/PORT，
// GX_BENCH=on 才挂观测头；读/keyset 档由 run-gate 透传，默认全 off。

import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ServerHandle {
  baseUrl: string;
  token: string;
  pid: number;
  stop: () => void;
}

export interface ServerFlags {
  read: "off" | "shadow" | "on";
  keyset: "off" | "shadow" | "on";
  prefetch: "on" | "off";
}

/**
 * S5b-P2 可选 CPU profile（仅 bench，不碰 src/index.ts）。
 * 启用时给被测 node 透传 --cpu-prof 系列 argv；dir 落 bench 输出目录（gitignored），
 * name 为场景 tag。Node 在进程退出时把 isolate-*.cpuprofile 写到 dir。
 */
export interface CpuProfOpt {
  dir: string;
  name: string;
}

/**
 * 被测进程 argv 纯构造（便于单测锁定 off 字节一致）。
 * 关：恒为 [script]，与接入前完全相同；开：注入 bench 专用 SIGTERM 预加载（让 --cpu-prof
 * 在 SIGTERM 下仍 flush，见 cpu-prof-exit.mjs）+ 三个 --cpu-prof 参数，再接 script。
 * 仍由调用方用受管 process.execPath 启动，这里只决定参数。
 */
export function buildServerArgs(script: string, prof?: CpuProfOpt, preloadPath?: string): string[] {
  if (!prof) return [script];
  const head = preloadPath ? [`--import=${preloadPath}`] : [];
  return [
    ...head,
    "--cpu-prof",
    `--cpu-prof-dir=${prof.dir}`,
    `--cpu-prof-name=${prof.name}`,
    script,
  ];
}

/** 找一个当前空闲的 TCP 端口（监听后立刻释放，降低竞态；起服务失败再重试由调用方处理）。 */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("无法获取空闲端口")));
      }
    });
    srv.on("error", reject);
  });
}

/**
 * 生产构建（esbuild 扁平 dist/index.js）；幂等。
 * pnpm 入口解析：优先环境变量 GX_PNPM_CJS（受管 node + corepack pnpm9 的 pnpm.cjs 绝对路径，
 * CI/本机钉版用），否则回退 PATH 上的 pnpm。node 一律用当前进程的 process.execPath，
 * 保证 harness 与被测服务是同一个受管 Node（避免 homebrew node/pnpm10 漂移）。
 */
export function buildProduction(apiRoot: string): void {
  console.log("[server] 构建生产 dist ...");
  const pnpmCjs = process.env.GX_PNPM_CJS;
  if (pnpmCjs) {
    execFileSync(process.execPath, [pnpmCjs, "run", "build"], { cwd: apiRoot, stdio: "inherit", env: process.env });
  } else {
    execFileSync("pnpm", ["run", "build"], { cwd: apiRoot, stdio: "inherit", env: process.env });
  }
}

async function waitReady(baseUrl: string, timeoutMs: number, logFile: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/readyz`, {});
      if (r.status === 200) return;
      lastErr = `readyz status=${r.status}`;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-1200) : "";
  throw new Error(`服务 ${timeoutMs}ms 内未就绪：${lastErr}\n--- server log tail ---\n${tail}`);
}

/**
 * 起生产服务并完成真实登录。
 * @param apiRoot apps/api 绝对路径
 * @param dbFile  压测库绝对路径
 * @param creds   登录邮箱/口令（gen-data 固定 bench 身份）
 */
export async function startServer(opts: {
  apiRoot: string;
  dbFile: string;
  email: string;
  password: string;
  flags: ServerFlags;
  logFile: string;
  port?: number;
  skipBuild?: boolean;
  /** 传入即给被测 node 加 --cpu-prof（S5b-P2）；name 建议带阶段（read/write）+场景 tag。 */
  cpuProf?: CpuProfOpt;
}): Promise<ServerHandle> {
  const { apiRoot, dbFile, email, password, flags, logFile } = opts;
  if (!opts.skipBuild) buildProduction(apiRoot);

  const port = opts.port ?? (await findFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  // 生产进程 cwd=apps/api，默认 dataDir 会落到发布目录（可能只读）导致 readyz uploadsWritable
  // 失败；显式把数据/上传根指到压测库旁的可写目录（与 DATABASE_URL 同生命周期，专用库）。
  const dataDir = path.join(path.dirname(dbFile), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: `file:${dbFile}`,
    GX_DATA_DIR: dataDir,
    JWT_SECRET: "bench-production-secret-9f8e7d6c", // 32 位，非内置开发密钥，过生产闸门
    CORS_ORIGIN: "http://localhost:5173",
    PORT: String(port),
    GX_BENCH: "on",
    // 压测必关限流：600/min 兜底会把高并发读压成 429，污染失败率。
    GX_RATE_LIMIT: "off",
    GX_AUDIT_DIR: path.join(dataDir, "audit"),
    BACKUP_DIR: path.join(dataDir, "backups"),
    GX_M1_SIDECAR_READ: flags.read,
    GX_M1_KEYSET: flags.keyset,
    GX_HYDRATE_PREFETCH: flags.prefetch,
  };

  const out = fs.openSync(logFile, "w");
  // --cpu-prof 要求目标目录存在（Node 不会自建），先建好；dir 落 bench 输出目录（gitignored）。
  if (opts.cpuProf) fs.mkdirSync(opts.cpuProf.dir, { recursive: true });
  // bench 专用 SIGTERM 预加载（与本文件同目录），使 --cpu-prof 在 stop() 的 SIGTERM 下落盘；
  // 仅 cpuProf 启用时传入，正常门 argv 不含它（buildServerArgs off 分支恒 [script]）。
  const profPreload = opts.cpuProf
    ? path.join(path.dirname(fileURLToPath(import.meta.url)), "cpu-prof-exit.mjs")
    : undefined;
  // 用与 harness 同一个受管 Node（process.execPath），避免 PATH 上的 node 版本漂移。
  // argv 仅在显式传 cpuProf 时变化；不传与接入前字节一致（buildServerArgs 单测锁定）。
  const child: ChildProcess = spawn(
    process.execPath,
    buildServerArgs("dist/index.js", opts.cpuProf, profPreload),
    {
      cwd: apiRoot,
      env,
      stdio: ["ignore", out, out],
    },
  );
  const stop = (): void => {
    if (!child.killed) {
      child.kill("SIGTERM");
      try {
        fs.closeSync(out);
      } catch {
        /* 已关闭 */
      }
    }
  };
  child.on("exit", (code, signal) => {
    // 任何非正常退出都必须可见，否则 harness 只看到 connection refused：
    //  - code≠0：非零退出；
    //  - code=null 且 signal 非 SIGTERM：被信号杀死。stop() 主动发的是 SIGTERM（优雅停机），
    //    属正常；SIGKILL 典型是 OOM jetsam，SIGSEGV/SIGABRT 是 native 崩溃，必须记录。
    const abnormal = code !== 0 && (code !== null || (signal !== "SIGTERM"));
    if (abnormal) {
      fs.appendFileSync(
        logFile,
        `[server] 子进程异常退出 code=${code} signal=${signal}` +
          (signal === "SIGKILL" ? "（疑似 OOM 被系统杀死，检查 RSS 峰值/内存压力）" : "") + "\n",
      );
    }
    try {
      fs.closeSync(out);
    } catch {
      /* 已关闭 */
    }
  });

  await waitReady(baseUrl, 30_000, logFile);

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (loginRes.status !== 200) {
    stop();
    throw new Error(`bench 登录失败 status=${loginRes.status} body=${await loginRes.text()}`);
  }
  const loginBody = (await loginRes.json()) as { token?: string };
  if (!loginBody.token) {
    stop();
    throw new Error("bench 登录响应无 token");
  }

  return { baseUrl, token: loginBody.token, pid: child.pid ?? -1, stop };
}
