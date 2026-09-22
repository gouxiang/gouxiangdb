// spawn dist/index.js 真跑：临时库先迁移，临时端口启动，轮询 /readyz，全量捕获子进程输出。
//
// 跨平台/隔离要求（运维九条）：仅用 node 内置 API；临时 DATABASE_URL（绝不碰真库）；临时端口
// （不绑 3001）；临时 GX_DATA_DIR（不写真机 uploads/audit）；离线（不开 GX_M5_SEARCH）；
// 30s 预算、250ms 轮询；失败回吐全部 stdout/stderr；无论成败都收尸。

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";

export const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

// ESM 无 require；用 createRequire 仅为解析 prisma CLI 的真实文件路径（跨平台、不依赖 PATH）。
const localRequire = createRequire(import.meta.url);

/**
 * 解析本机 prisma CLI 入口。
 * @returns {string}
 */
export function resolvePrismaBin() {
  const pkgJson = localRequire.resolve("prisma/package.json");
  /** @type {{ bin: { prisma: string } | string }} */
  const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.prisma;
  return localRequire.resolve("prisma/" + binRel);
}

/**
 * 取一个 ephemeral 端口（listen port 0 后立即释放，再交给目标进程）。
 * @returns {Promise<number>}
 */
export function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("无法解析临时端口"));
      }
    });
  });
}

/**
 * 对临时库跑 prisma migrate deploy（DATABASE_URL 由 env 注入）。
 * @param {string} prismaBin
 * @param {string} schemaPath
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<void>}
 */
export function migrateTempDb(prismaBin, schemaPath, env) {
  return new Promise((resolve, reject) => {
    /** @type {string[]} */
    const out = [];
    const child = spawn(
      process.execPath,
      [prismaBin, "migrate", "deploy", `--schema=${schemaPath}`],
      { env },
    );
    child.stdout.on("data", (d) => out.push(d.toString()));
    child.stderr.on("data", (d) => out.push(d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`临时库 migrate deploy 失败 (exit ${code})\n${out.join("")}`));
    });
  });
}

/**
 * 启动 dist/index.js 并等待 /readyz（status==="ready" 且 checks 各项为 true）。
 * @param {{ distEntry: string, port: number, env: NodeJS.ProcessEnv }} opts
 * @returns {Promise<{ ok: boolean, reason?: "timeout"|"bad-probe"|"crashed",
 *   detail: string, stdout: string, stderr: string, cleanup: () => void }>}
 */
export async function runIndexUntilReady(opts) {
  /** @type {string[]} */
  const stdout = [];
  /** @type {string[]} */
  const stderr = [];
  const child = spawn(process.execPath, [opts.distEntry], { env: opts.env });
  /** @type {{ code: number | null } | null} */
  let exited = null;
  child.stdout.on("data", (d) => stdout.push(d.toString()));
  child.stderr.on("data", (d) => stderr.push(d.toString()));
  child.on("exit", (code) => { exited = { code }; });

  let killed = false;
  const cleanup = () => {
    if (killed || exited) return;
    killed = true;
    try { child.kill("SIGTERM"); } catch { /* best-effort */ }
  };

  /**
   * @param {"timeout"|"bad-probe"|"crashed"} reason
   * @param {string} detail
   */
  const fail = (reason, detail) => ({
    ok: false, reason, detail,
    stdout: stdout.join(""), stderr: stderr.join(""), cleanup,
  });

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      return fail("crashed", `进程在 ready 前退出 (exit ${exited.code})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/readyz`);
      /** @type {{ status?: string, checks?: Record<string, unknown> }} */
      const body = await res.json();
      const checksOk = body.checks
        ? Object.values(body.checks).every((v) => v === true)
        : false;
      if (res.status === 200 && body.status === "ready" && checksOk) {
        return {
          ok: true, detail: "ready",
          stdout: stdout.join(""), stderr: stderr.join(""), cleanup,
        };
      }
      // 503 = 探针已响应但未就绪（可能仍在迁移/冷启动）：继续等，不当死。
    } catch {
      // 连接被拒 = 还没起监听；继续轮询。
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return fail("timeout", `${STARTUP_TIMEOUT_MS}ms 内 /readyz 未就绪`);
}
