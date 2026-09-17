// M6/S8 真服务 e2e 基座（服务端侧）：真监听 + 真 HTTP 客户端。
//
// 本片硬要求（M6-implementation-plan §S8 / 派工单）：三客户端必须打到**真监听端口**，
// 禁用 `app.request` 直调（那是 S2-S7 的形态，不经网络栈，证不了"第三方能连"）。
//
// 提供能力：
//   ① 环境准备（临时 DATABASE_URL / 审计目录 / 真迁移）与还原；
//   ② 真服务起停：TCP（随机端口，serve()）与 unix socket（node:http + socketPath），
//      与 index.ts 用同一对 API（serve / getRequestListener），不是另造一套；
//   ③ 三客户端形态：fetch（原始 HTTP）、curl 子进程（**独立实现**的第三方 HTTP 客户端）、
//      官方 SDK（客户端在 clientHarness.ts，因为它还需要 stdio）。

import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { execSync, execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { getRequestListener, serve } from "@hono/node-server";
import type { Hono } from "hono";

/** 本片需要接管/还原的环境变量（缺省状态即"根路径 + TCP + /mcp 挂载 + M5 off"）。 */
export const E2E_ENV_KEYS = [
  "DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV",
  "GX_RATE_LIMIT", "GX_ENTERPRISE_ORG", "GX_ENTERPRISE_NAV", "GX_M5_SEARCH",
  "GX_BASE_PATH", "GX_SOCKET_PATH", "GX_MCP_TOKEN", "GX_MCP_BODY_LIMIT", "GX_MCP_TOOL_TIMEOUT_MS",
] as const;

export interface E2eEnv {
  tmpDir: string;
  auditDir: string;
  prev: Record<string, string | undefined>;
}

/** 建临时库环境（**必须在 import app 之前调用**：config 在 import 时冻结）。 */
export function prepareEnv(label: string): E2eEnv {
  const prev: Record<string, string | undefined> = {};
  for (const k of E2E_ENV_KEYS) prev[k] = process.env[k];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  const auditDir = path.join(tmpDir, ".audit");
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "e2e.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = auditDir;
  process.env.JWT_SECRET = "m6-s8-e2e-secret-at-least-16";
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off"; // 限流有独立专项用例（引用 S2 测试）；本片不喂 429 噪音
  delete process.env.GX_ENTERPRISE_ORG; // 缺省 on -> /mcp 挂载
  delete process.env.GX_ENTERPRISE_NAV;
  delete process.env.GX_M5_SEARCH; // off -> record.search 不注册，工具集确定
  delete process.env.GX_BASE_PATH;
  delete process.env.GX_SOCKET_PATH;
  delete process.env.GX_MCP_TOKEN;
  delete process.env.GX_MCP_BODY_LIMIT;
  delete process.env.GX_MCP_TOOL_TIMEOUT_MS;
  return { tmpDir, auditDir, prev };
}

export function restoreEnv(env: E2eEnv): void {
  for (const [k, v] of Object.entries(env.prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * 真迁移（真 prisma migrate deploy 到临时库；产品码零改动）。
 * `timeout` 是硬护栏：execSync 会**阻塞事件循环**，此时 vitest 的 testTimeout 无法生效，
 * 故必须由 child_process 自己兜底（否则表现为"整轮静默挂死"，无从定位）。
 */
export function migrateFresh(): void {
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env, timeout: 300_000,
  });
}

/* ------------------------------ 目标（服务形态） ------------------------------ */

export type E2eTarget =
  | { kind: "tcp"; origin: string }
  | { kind: "unix"; origin: string; socketPath: string };

export interface RunningServer {
  target: E2eTarget;
  close: () => Promise<void>;
}

/** 取一个空闲端口（listen(0) 后立即释放；随后 serve() 绑定同端口）。 */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** 真 TCP 监听（与 index.ts 同用 serve()）。 */
export async function startTcpServer(app: Hono): Promise<RunningServer> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const srv = serve({ fetch: app.fetch, port });
  const target: E2eTarget = { kind: "tcp", origin };
  await waitForHttp(target);
  return { target, close: async () => { srv.close(); await new Promise((r) => setTimeout(r, 50)); } };
}

/** 真 unix socket 监听（与 index.ts startUnixSocket 同用 createServer + getRequestListener）。 */
export async function startUnixServer(app: Hono, socketPath: string): Promise<RunningServer> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.rmSync(socketPath, { force: true });
  const srv: Server = createHttpServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(socketPath, () => resolve());
  });
  const target: E2eTarget = { kind: "unix", origin: "http://unix.local", socketPath };
  await waitForHttp(target);
  return {
    target,
    close: async () => {
      (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      fs.rmSync(socketPath, { force: true });
      await new Promise<void>((r) => srv.close(() => r()));
    },
  };
}

/**
 * unix socket 的 FetchLike：把请求经 node:http(socketPath) 打到真 socket。
 * 用途：官方 SDK 的 `StreamableHTTPClientTransport` 支持注入 fetch（`opts.fetch`），
 * 因此 SDK 矩阵也能跑 unix 形态而不必退化成 TCP。
 */
export function unixFetch(socketPath: string): typeof fetch {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const isReq = typeof input === "object" && input !== null && "url" in input;
    const rawUrl = typeof input === "string" ? input : isReq ? (input as Request).url : (input as URL).href;
    const url = new URL(rawUrl);
    const method = init?.method ?? (isReq ? (input as Request).method : "GET");
    const srcHeaders = init?.headers ?? (isReq ? (input as Request).headers : undefined);
    const headers: Record<string, string> = {};
    if (srcHeaders) for (const [k, v] of new Headers(srcHeaders)) headers[k] = v;
    const body = init?.body ?? (isReq ? await (input as Request).text() : undefined);
    const chunks: Buffer[] = [];
    const res = await new Promise<{ status: number; headers: IncomingHttpHeaders }>((resolve, reject) => {
      const req = httpRequest({ socketPath, path: `${url.pathname}${url.search}`, method, headers }, (r) => {
        r.on("data", (d: Buffer) => chunks.push(d));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers }));
      });
      req.on("error", (e) => { console.error("[unixFetch] req error:", (e as Error).message, (e as Error & { code?: string }).code); reject(e); });
      if (typeof body === "string") req.write(body);
      else if (body instanceof Uint8Array) req.write(Buffer.from(body));
      req.end();
    });
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (k === "transfer-encoding" || k === "content-encoding" || k === "content-length") continue;
      if (typeof v === "string") out.set(k, v);
    }
    return new Response(Buffer.concat(chunks), { status: res.status, headers: out });
  };
  return impl as unknown as typeof fetch;
}

export function fetchFor(target: E2eTarget): typeof fetch {
  return target.kind === "unix" ? unixFetch(target.socketPath) : fetch;
}

/** 轮询 /healthz 直到真服务可服务（所有矩阵统一入口，避免"还没 listen 就发请求"的假绿）。 */
export async function waitForHttp(target: E2eTarget, timeoutMs = 20_000): Promise<void> {
  const f = fetchFor(target);
  const started = Date.now();
  for (;;) {
    try {
      const res = await f(`${target.origin}/healthz`);
      if (res.status === 200) return;
    } catch {
      /* 未就绪：重试 */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`真服务未就绪：${target.origin}${target.kind === "unix" ? target.socketPath : ""}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* ------------------------------ 客户端 ①：原始 fetch ------------------------------ */

export const MCP_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

export const INIT_MESSAGE = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "gx-m6-s8-e2e", version: "0.1.0" } },
};

export interface RpcOptions { pathname?: string; token?: string; headers?: Record<string, string> }

export function rpc(target: E2eTarget, body: unknown, opts: RpcOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...MCP_HEADERS, ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return fetchFor(target)(`${target.origin}${opts.pathname ?? "/mcp"}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

export function callMessage(name: string, args: Record<string, unknown> = {}, id = 2): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

export function listMessage(id = 3): unknown {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

export interface ToolEnvelope {
  status: number;
  isError: boolean | undefined;
  /** 工具层正文（result.content[0].text）；协议错误时为 ""。 */
  text: string;
  /** 协议层错误（如未注册工具 -32602）；工具层错误时为 null。 */
  protocolError: { code: number; message: string } | null;
}

export async function callTool(target: E2eTarget, token: string, name: string, args: Record<string, unknown> = {}, opts: Omit<RpcOptions, "token"> = {}): Promise<ToolEnvelope> {
  const res = await rpc(target, callMessage(name, args), { ...opts, token });
  const body = (await res.json()) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
    error?: { code: number; message: string };
  };
  return {
    status: res.status,
    isError: body.result?.isError,
    text: body.result?.content?.[0]?.text ?? "",
    protocolError: body.error ? { code: body.error.code, message: body.error.message } : null,
  };
}

export async function listTools(target: E2eTarget, token: string, opts: Omit<RpcOptions, "token"> = {}): Promise<string[]> {
  const res = await rpc(target, listMessage(), { ...opts, token });
  const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
  return (body.result?.tools ?? []).map((t) => t.name).sort();
}

/** 便捷：解析工具层 JSON 正文。 */
export function parseText<T>(env: ToolEnvelope): T {
  return JSON.parse(env.text) as T;
}

/* ------------------------------ 客户端 ②：curl 子进程 ------------------------------ */

export interface CurlResult { status: number; body: string }

/**
 * curl 可用性（本片 curl 组是子进程真实第三方客户端，不是 Node fetch 冒充）。
 * spawnSync 在此**安全**：不与被测服务交互，不构成事件循环自死锁。
 */
export function curlAvailable(): boolean {
  return spawnSync("curl", ["--version"], { encoding: "utf8" }).status === 0;
}

/**
 * 真 curl 子进程（独立于 Node 的第二套 HTTP 实现，即"curl 裸 JSON-RPC"客户端）。
 *
 * **必须 async（不能用 spawnSync）**：被测服务在本进程内监听，同步等待子进程会阻塞事件循环，
 * 自己把自己饿死（curl 连不上 → 永久挂起，且 vitest 的 testTimeout 也无法触发）。
 * 这是本片踩到的第一个坑，已在 baseline 记录。
 *
 * 纪律：**token 绝不进 argv**（`ps` 可见）——请求头写 0600 临时文件后用 `-H @file` 传入，用完即删。
 */
export async function curlRpc(target: E2eTarget, body: unknown, token?: string, pathname = "/mcp"): Promise<CurlResult> {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bodyFile = path.join(os.tmpdir(), `gx-e2e-body-${stamp}.json`);
  const headerFile = path.join(os.tmpdir(), `gx-e2e-hdr-${stamp}.txt`);
  fs.writeFileSync(bodyFile, JSON.stringify(body), { mode: 0o600 });
  const lines = [`content-type: ${MCP_HEADERS["content-type"]!}`, `accept: ${MCP_HEADERS.accept!}`];
  if (token) lines.push(`Authorization: Bearer ${token}`);
  fs.writeFileSync(headerFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  const args = [
    "-sS", "--connect-timeout", "10", "--max-time", "60",
    "-w", "\n%{http_code}", "-X", "POST", "-H", `@${headerFile}`, "--data-binary", `@${bodyFile}`,
  ];
  if (target.kind === "unix") args.push("--unix-socket", target.socketPath);
  args.push(`${target.origin}${pathname}`);
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("curl", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 70_000 }, (err, out) => {
        if (err) reject(err);
        else resolve(out);
      });
    });
    const cut = stdout.lastIndexOf("\n");
    return { status: Number(stdout.slice(cut + 1).trim()), body: stdout.slice(0, cut) };
  } finally {
    fs.rmSync(bodyFile, { force: true });
    fs.rmSync(headerFile, { force: true });
  }
}
