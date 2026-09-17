// M6/S8 e2e 基座（客户端侧）：官方 SDK 的 HTTP 与 stdio 两种 client，以及审计读取。
//
// 权威依据：M6-implementation-plan §S8（三客户端 + stdio 第二入口）。
//   - `StreamableHTTPClientTransport` 从 @modelcontextprotocol/sdk/client/streamableHttp.js
//     （apps/api dependencies 内已有 1.30.0，与服务端同版本，保证协议对拍不是跨版本猜测）；
//   - `StdioClientTransport` 起真子进程（`tsx src/mcp/stdio.ts`），不是手搓 JSON-RPC 行。

import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { unixFetch, type E2eTarget } from "./serverHarness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** src/e2e -> src -> apps/api */
export const API_ROOT = path.resolve(HERE, "../..");
/**
 * stdio 出口门验**生产产物**（派工单 §A-4：真 spawn dist/mcp-stdio.js，非 tsx 直跑 src/）。
 * 产物由 vitest.e2e globalSetup 调 scripts/build.mjs 生成；dist 在 .gitignore 内。
 */
const STDIO_BIN = path.join(API_ROOT, "dist", "mcp-stdio.js");

function stdioCommand(): { command: string; args: string[] } {
  if (!fs.existsSync(STDIO_BIN)) {
    throw new Error(`[m6-s8] 缺少 stdio 生产产物 ${STDIO_BIN}：e2e globalSetup 应先构建（GX_S8_SKIP_BUILD 未设时自动构建）`);
  }
  return { command: process.execPath, args: [STDIO_BIN] };
}

export interface SdkConnection {
  client: Client;
  close: () => Promise<void>;
}

/** 客户端 ③：官方 SDK `StreamableHTTPClientTransport`（"任意第三方 AI host 能接"的核心证据）。 */
export async function openSdkClient(target: E2eTarget, token: string, pathname = "/mcp"): Promise<SdkConnection> {
  const opts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  };
  // unix 形态：SDK 支持注入 fetch（streamableHttp.js: `this._fetch ?? fetch`），无需改全局 fetch。
  if (target.kind === "unix") opts.fetch = unixFetch(target.socketPath);
  const transport = new StreamableHTTPClientTransport(new URL(`${target.origin}${pathname}`), opts);
  const client = new Client({ name: "gx-m6-s8-sdk", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => { await transport.close().catch(() => undefined); },
  };
}

/** 子进程 env：继承当前测试环境（含临时 DATABASE_URL），只覆盖/删除 GX_MCP_TOKEN。 */
export function stdioEnv(token?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  if (token === undefined) delete env.GX_MCP_TOKEN;
  else env.GX_MCP_TOKEN = token;
  return env;
}

/** stdio 客户端（官方 `StdioClientTransport`，真 spawn 生产产物 dist/mcp-stdio.js）。 */
export async function openStdioClient(token: string): Promise<SdkConnection> {
  const { command, args } = stdioCommand();
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: API_ROOT,
    env: stdioEnv(token),
    stderr: "pipe",
  });
  const client = new Client({ name: "gx-m6-s8-stdio", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => { await client.close().catch(() => undefined); },
  };
}

export interface StdioExit { code: number | null; stderr: string; stdout: string }

/** 跑到自然退出（用于"启动即拒"场景：断言退出码 2 且 stdout 零污染）。 */
export async function runStdioToExit(token?: string): Promise<StdioExit> {
  const { command, args } = stdioCommand();
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd: API_ROOT, env: stdioEnv(token), stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const code = await new Promise<number | null>((resolve) => { child.on("exit", (c) => resolve(c)); });
  return { code, stderr, stdout };
}

/* ------------------------------ 审计读取 ------------------------------ */

export interface AuditRecord {
  ts?: string;
  event?: string;
  actorId?: string | null;
  ip?: string;
  method?: string;
  path?: string;
  status?: number;
  detail?: Record<string, unknown>;
}

/** 读 $GX_AUDIT_DIR/audit.logl（一行一条 JSON；坏行忽略）。 */
export function readAudit(auditDir: string): AuditRecord[] {
  const file = path.join(auditDir, "audit.logl");
  if (!fs.existsSync(file)) return [];
  const rows: AuditRecord[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line) as AuditRecord); } catch { /* 坏行忽略 */ }
  }
  return rows;
}

/** 按事件名过滤（审计断言用）。 */
export function auditOf(rows: AuditRecord[], event: string): AuditRecord[] {
  return rows.filter((r) => r.event === event);
}
