// M6/S6 stdio 第二入口验收（**真 spawn**，非纯函数）：
//   ① 缺 GX_MCP_TOKEN -> 退出码 2（stderr 有说明）
//   ② 非法 token（无前缀 / 带前缀但查不到）-> 退出码 2
//   ③ 合法 PAT -> stdin 写 initialize + initialized + tools/list + resources/list，
//      断言 stdout 是合法 JSON-RPC，且工具按 scope 过滤、Resources 与 HTTP 共用同一 buildServer。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { createNavNodes, createPolicies } from "../../../domain/authz/__tests__/engineHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";

const ENV_KEYS = ["DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV",
  "GX_RATE_LIMIT", "GX_ENTERPRISE_ORG", "GX_M5_SEARCH", "GX_MCP_TOKEN"] as const;
const PREV: Record<string, string | undefined> = {};

const HERE = path.dirname(fileURLToPath(import.meta.url));
// __tests__ -> transport -> mcp -> src -> apps/api
const API_ROOT = path.resolve(HERE, "../../../..");
const TSX_CLI = path.join(API_ROOT, "node_modules/tsx/dist/cli.mjs");

let tmpDir: string;
let prisma: PrismaClient;
let canvasToken = "";
let canvasDocId = "";
const childEnvBase: Record<string, string> = {};

/** 复制 process.env 并应用覆盖（undefined = 删除该键）。 */
function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, ...childEnvBase };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete e[k];
    else e[k] = v;
  }
  return e;
}

function spawnStdio(overrides: Record<string, string | undefined>): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [TSX_CLI, "src/mcp/stdio.ts"], {
    cwd: API_ROOT,
    env: childEnv(overrides),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** 跑到自然退出，收集退出码与 stderr（用于退出码场景）。 */
async function runToExit(overrides: Record<string, string | undefined>): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const child = spawnStdio(overrides);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const code = await new Promise<number | null>((resolve) => { child.on("exit", (c) => resolve(c)); });
  return { code, stderr, stdout };
}

function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

interface Handshake { lines: Array<{ id?: number; result?: any; error?: unknown }>; stderr: string }

/** 起子进程 -> 发 initialize/initialized/tools-list/resources-list -> 读到 target id 后 kill。 */
async function runHandshake(targetId: number): Promise<Handshake> {
  const child = spawnStdio({ GX_MCP_TOKEN: canvasToken });
  const lines: Handshake["lines"] = [];
  let stderr = "";
  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { lines.push(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ } }
    }
  });
  child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
  const send = (o: unknown) => child.stdin.write(`${JSON.stringify(o)}\n`);

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "s6-test", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} });

  try {
    await waitFor(() => lines.some((l) => l.id === targetId), 40000);
  } finally {
    child.kill("SIGKILL");
    await new Promise((r) => { child.on("exit", r); });
  }
  return { lines, stderr };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s6-stdio-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s6stdio.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = "m6-s6-stdio-secret-at-least-16";
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_M5_SEARCH;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", { cwd: process.cwd(), stdio: "ignore", env: process.env });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  await prisma.user.create({ data: { id: "u1", email: "u1@x.com", displayName: "u1", passwordHash: "x", status: "ACTIVE" } });
  const kb = await prisma.knowledgeBase.create({ data: { id: "kb1", name: "库一", createdBy: "owner0" } });
  canvasDocId = (await prisma.kbDoc.create({
    data: { kbId: kb.id, kind: "canvas", title: "画布一", content: JSON.stringify([{ id: "r1", type: "geometry", shape: "rectangle", points: [[0, 0], [10, 0], [10, 10], [0, 10]] }]), createdBy: "owner0", updatedBy: "owner0" },
  })).id;
  await createNavNodes(prisma, [
    { id: nodeId("kb", "kb1"), kind: "kb", resourceType: "kb", resourceId: "kb1" },
    { id: nodeId("canvas", canvasDocId), kind: "canvas", resourceType: "canvas", resourceId: canvasDocId, parentId: nodeId("kb", "kb1") },
  ]);
  await createPolicies(prisma, [
    { id: "p_cv", nodeId: nodeId("canvas", canvasDocId), subjectType: "user", subjectId: "u1", actions: "r" },
  ]);
  const svc = await import("../../pat/patService.js");
  canvasToken = (await svc.createPat("u1", { name: "cv", scopes: ["canvas:read"], expiresInDays: 90 })).plaintext;

  // 子进程 env 基线：与 beforeAll 一致（子进程不复用 vitest 的内存态）
  Object.assign(childEnvBase, {
    DATABASE_URL: process.env.DATABASE_URL!,
    GX_DATA_DIR: tmpDir,
    GX_AUDIT_DIR: process.env.GX_AUDIT_DIR!,
    JWT_SECRET: process.env.JWT_SECRET!,
    NODE_ENV: "test",
    GX_RATE_LIMIT: "off",
  });
  delete childEnvBase.GX_ENTERPRISE_ORG;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("S6 stdio 退出码 2（真 spawn）", () => {
  it("缺 GX_MCP_TOKEN -> 退出码 2，stderr 有明确说明，stdout 不污染", async () => {
    const r = await runToExit({ GX_MCP_TOKEN: undefined });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("GX_MCP_TOKEN");
    expect(r.stdout).toBe(""); // 协议流绝不被诊断污染
  }, 60000);

  it("非法 token（无 gxpat_ 前缀）-> 退出码 2", async () => {
    const r = await runToExit({ GX_MCP_TOKEN: "not-a-pat-value" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("GX_MCP_TOKEN");
  }, 60000);

  it("带前缀但查不到的 token -> 退出码 2（走查库 + dummy 抹时序路径）", async () => {
    const r = await runToExit({ GX_MCP_TOKEN: `gxpat_${"A".repeat(32)}` });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("GX_MCP_TOKEN");
  }, 60000);
});

describe("S6 stdio 合法 PAT 握手（真 spawn + JSON-RPC）", () => {
  it("initialize / tools/list / resources/list 均返回合法 JSON-RPC；工具按 scope 过滤、Resources 共用 buildServer", async () => {
    const { lines, stderr } = await runHandshake(3);

    const init = lines.find((l) => l.id === 1);
    expect(init, `initialize 无响应；stderr=${stderr}`).toBeTruthy();
    expect(init!.result.serverInfo.name).toBe("gouxiangdb-mcp");

    const tools = lines.find((l) => l.id === 2);
    expect(tools, `tools/list 无响应；stderr=${stderr}`).toBeTruthy();
    const names = (tools!.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    // canvas:read 只读 PAT：恰为连接性工具 + canvas 读工具（写工具不注册）
    expect(names).toEqual(["base.create_base", "canvas.get_board", "kb.create_kb", "ping_echo"]);

    const res = lines.find((l) => l.id === 3);
    expect(res, `resources/list 无响应；stderr=${stderr}`).toBeTruthy();
    const uris = (res!.result.resources as Array<{ uri: string }>).map((r) => r.uri).sort();
    expect(uris).toEqual(["gx://manuals/blocks", "gx://manuals/canvas", "gx://manuals/table"]);
  }, 90000);
});
