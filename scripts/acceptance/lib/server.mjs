// scripts/acceptance/lib/server.mjs
// 子进程服务生命周期（v0.1.0 旧服务 / 当前候选服务）。单一职责：起进程、轮询就绪、
// 返回 {pid, baseUrl, stop()}。只 kill 自己记录的 PID，绝不 pkill（避免误伤 vitest 等）。

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { waitForHealth } from "./http.mjs";

/**
 * 启动一个服务实例。
 *
 * @param {object} opts
 * @param {string} opts.name          日志标签（old/new）
 * @param {string} opts.cwd           服务工作目录（旧=worktree/apps/api，新=repo/apps/api）
 * @param {string} opts.entry         启动入口（旧用 tsx src/index.ts，新用 dist/index.js）
 * @param {number} opts.port
 * @param {string} opts.databaseUrl   绝对 file: URL
 * @param {string} [opts.dataDir]     GX_DATA_DIR（新服务）
 * @param {string} [opts.uploadRoot]  UPLOAD_ROOT
 * @param {Record<string,string>} [opts.extraEnv]
 * @param {string} opts.logFile       子进程 stdout/stderr 落盘文件
 * @param {string} [opts.runner]      非 dist 入口时的运行器（tsx），默认 node
 * @param {boolean} [opts.enterprise] 新服务企业旗标（GX_ENTERPRISE_ORG/NAV 默认 on，显式 off 时不设）
 * @param {number} [opts.readyTimeoutMs]
 */
export async function startServer(opts) {
  const {
    name, cwd, entry, port, databaseUrl, dataDir, uploadRoot,
    extraEnv = {}, logFile, runner, enterprise = true, readyTimeoutMs = 45000,
  } = opts;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, "a");

  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "development",
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    JWT_SECRET: "drill-secret-0123456789abcdef",
    GX_RATE_LIMIT: "off",
    ...extraEnv,
  };
  if (dataDir) env.GX_DATA_DIR = dataDir;
  if (uploadRoot) env.UPLOAD_ROOT = uploadRoot;
  // 当前候选服务：企业面默认 on（代码默认），仅显式要求 off 时摘除。
  if (!enterprise) {
    env.GX_ENTERPRISE_ORG = "off";
    env.GX_ENTERPRISE_NAV = "off";
  }

  const cmd = runner ?? process.execPath;
  const args = runner ? [entry] : [entry];
  // tsx 运行器：runner 指向 tsx 可执行，直接 [entry]；若 runner='tsx' 则解析 node + tsx 路径。
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", out, out], detached: false });

  const baseUrl = `http://127.0.0.1:${port}`;
  child.on("exit", (code) => {
    try { fs.appendFileSync(logFile, `\n[server:${name}] exited code=${code}\n`); } catch { /* ignore */ }
  });

  try {
    // 旧服务只有 /api/health；新服务有 /healthz。逐版本兼容探测。
    await Promise.race([
      waitForAnyHealth(baseUrl, readyTimeoutMs),
      new Promise((_, rej) => child.on("exit", (c) => rej(new Error(`服务 ${name} 提前退出 code=${c}，见 ${logFile}`)))),
    ]);
  } catch (e) {
    killQuiet(child);
    throw e;
  }

  return {
    pid: child.pid,
    baseUrl,
    port,
    process: child,
    async stop() {
      await new Promise((resolve) => {
        child.once("exit", () => resolve());
        killQuiet(child);
        setTimeout(resolve, 3000).unref?.();
      });
    },
  };
}

async function waitForAnyHealth(baseUrl, timeoutMs) {
  const start = Date.now();
  for (;;) {
    for (const p of ["/healthz", "/api/health"]) {
      try {
        const res = await fetch(`${baseUrl}${p}`);
        if (res.ok) return;
      } catch { /* try next */ }
    }
    if (Date.now() - start > timeoutMs) throw new Error(`服务未在 ${timeoutMs}ms 内就绪：${baseUrl}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function killQuiet(child) {
  try {
    if (!child.killed) child.kill("SIGTERM");
  } catch { /* already gone */ }
}
