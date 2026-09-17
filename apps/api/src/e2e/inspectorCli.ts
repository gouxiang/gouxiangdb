// M6/S8 客户端④：MCP Inspector CLI（官方调试器）非交互驱动。
//
// 依据（派工单 §B-3）：**必须 pin 具体版本**（禁止 @latest，否则 SDK 升级会静默改变握手行为）；
// CI/本机受网络限制拉不到、或无法非交互驱动时**允许降级为基线手测留证**，
// 但**不许静默跳过、不许假装跑过**——本模块把"未自动化"变成一个显式、可检索的结果，
// 由用例转成 console.warn + baseline 的【未自动化 + 原因】条目，而非一个假的 pass。
//
// 安全注记：Inspector CLI 的 `--header` 只有 argv 形态（无 curl 的 `-H @file` 等价物），
// 故测试令牌会短暂出现在本机进程 argv 中。缓解：仅用于临时库一次性令牌、进程随即回收，
// 且 baseline 与报告一律以 `<PAT>` 占位，绝不落明文。

import { spawn } from "node:child_process";

/**
 * 固定版本（写进命令与 baseline；升级须同步跑本片 e2e）。
 * 为何是 0.16.6 而非更早：npx 对 0.16.5 直接拒绝（"version 0.16.5 is unsafe, please use 0.16.6 or later"）；
 * 且 0.16.5 的 URL 形态用位置参数传 server，0.16.6 改为 `--server-url`（位置参数会被 CLI 判为
 * "Arguments cannot be passed to a URL-based MCP server" → 实测踩到）。两点都在 baseline 记录。
 */
export const INSPECTOR_VERSION = "0.16.6";

export interface InspectorResult {
  ok: boolean;
  /** ok=false 时的原因（网络/驱动/超时）。 */
  reason: string;
  tools: string[];
  raw: string;
  elapsedMs: number;
}

/**
 * 非交互 `--cli` 模式跑 tools/list。
 *
 * **必须 async spawn（不能 spawnSync）**：被测服务监听在本进程内，同步等待会阻塞事件循环，
 * Inspector 的 initialize 永远等不到响应（与 curlRpc 同款自死锁）。
 */
export function runInspectorToolsList(url: string, token: string, timeoutMs = 180_000): Promise<InspectorResult> {
  const started = Date.now();
  // 参数形态是实测出来的（两次失败留证见 baseline §Inspector）：
  //   - server 必须作为**位置参数** `--cli <url>`（0.16.6 的 `--server-url` 会命中
  //     `argument("<target...>")` 的 "missing required argument 'target'"）；
  //   - `--header <headers...>` 是**变参**，必须放在位置参数之后，否则值会被当成第二个 target
  //     （0.16.5 无 --header → 该值沦为位置参数 → "Arguments cannot be passed to a URL-based MCP server."）。
  const args = [
    "-y", `@modelcontextprotocol/inspector@${INSPECTOR_VERSION}`,
    "--cli", url,
    "--transport", "http",
    "--method", "tools/list",
    "--header", `Authorization: Bearer ${token}`,
  ];
  return new Promise<InspectorResult>((resolve) => {
    const child = spawn("npx", args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    const finish = (): void => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - started;
      const raw = `${stdout}\n${stderr}`;
      if (timedOut) return resolve({ ok: false, reason: `Inspector 超时（>${timeoutMs}ms），疑网络拉包失败`, tools: [], raw, elapsedMs });
      const tools = [...stdout.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!);
      if (tools.length === 0) {
        const hint = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
        return resolve({ ok: false, reason: `未解析出工具列表（stderr 末三行：${hint || "空"}）`, tools: [], raw, elapsedMs });
      }
      resolve({ ok: true, reason: "", tools: [...new Set(tools)].sort(), raw, elapsedMs });
    };
    child.on("error", (e) => { stderr += `\n[spawn error] ${e.message}`; finish(); });
    child.on("exit", finish);
  });
}
