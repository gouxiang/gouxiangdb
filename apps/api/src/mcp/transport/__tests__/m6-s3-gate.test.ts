// M6/S3 双闸门路由级验收（真 app + 真 M4 夹具 + 真 PAT）：
//   ① 四身份 tools/list 快照；② 未注册工具与不存在工具响应同口径（不泄漏存在性）；
//   ③ IDOR：可见集外的资源不出现在结果里。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { createNavNodes, createPolicies } from "../../../domain/authz/__tests__/engineHarness.js";

const ENV_KEYS = ["DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV",
  "GX_RATE_LIMIT", "GX_ENTERPRISE_ORG"] as const;
const PREV: Record<string, string | undefined> = {};

let tmpDir: string;
let prisma: PrismaClient;
let app: { request: (u: string, i?: RequestInit) => Promise<Response> };
const tokens: Record<string, string> = {};

const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const NB = "s3_nav_b1", NT = "s3_nav_t1", NB2 = "s3_nav_b2";

function call(body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { ...H };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request("/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}
const toolNames = async (token: string): Promise<string[]> => {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, token);
  const body = await res.json() as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((t) => t.name).sort();
};

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s3-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s3.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = "m6-s3-secret-at-least-16-chars";
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  delete process.env.GX_ENTERPRISE_ORG;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  // 主体：uFull（可见 b1/t1 且字段受限）、uNone（无任何策略）、uOther（另有 b2）——用于 IDOR。
  for (const id of ["uFull", "uNone", "uOther"]) {
    await prisma.user.create({ data: { id, email: `${id}@x.com`, displayName: id, passwordHash: "x", status: "ACTIVE" } });
  }
  // S4 起 list_bases 会回填 name，故需真实 base 行（此前只造 nav 节点）
  await prisma.base.create({ data: { id: "b1", name: "库一", createdBy: "uFull" } });
  await prisma.base.create({ data: { id: "b2", name: "库二", createdBy: "uOther" } });
  await createNavNodes(prisma, [
    { id: NB, kind: "base", resourceType: "base", resourceId: "b1" },
    { id: NT, kind: "table", resourceType: "table", resourceId: "t1", parentId: NB },
    { id: NB2, kind: "base", resourceType: "base", resourceId: "b2" },
  ]);
  await createPolicies(prisma, [
    { id: "s3_p_base", nodeId: NB, subjectType: "user", subjectId: "uFull", actions: "r" },
    { id: "s3_p_table", nodeId: NT, subjectType: "user", subjectId: "uFull", actions: "r", fieldMask: JSON.stringify({ allowFields: ["f1"] }) },
    { id: "s3_p_other", nodeId: NB2, subjectType: "user", subjectId: "uOther", actions: "r" },
  ]);

  const svc = await import("../../pat/patService.js");
  const mk = async (userId: string, scopes: string[]): Promise<string> => {
    const r = await svc.createPat(userId, { name: userId, scopes: scopes as never, expiresInDays: 90 });
    return r.plaintext;
  };
  tokens.none = await mk("uNone", ["record:read"]);         // 身份①无权
  tokens.readonly = await mk("uFull", ["record:read"]);     // 身份②只读
  tokens.readwrite = await mk("uFull", ["record:read", "record:write"]); // 身份③读写
  tokens.masked = await mk("uFull", ["record:read"]);        // 身份④字段受限（同 uFull，字段面在 S4 收窄）
  tokens.noScope = await mk("uFull", ["doc:read"]);          // scope 粗筛用
  tokens.other = await mk("uOther", ["record:read"]);        // IDOR 对照

  app = (await import("../../../app.js")).createApp().app as unknown as typeof app;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("S3 四身份 tools/list 快照", () => {
  it("① 无权（族为空）-> 仅连接性工具", async () => {
    expect(await toolNames(tokens.none!)).toEqual(["ping_echo"]);
  });

  it("② 只读（有可见 base）-> 出现该族全部读工具", async () => {
    expect(await toolNames(tokens.readonly!)).toEqual(["ping_echo", "record.list_records", "record.query_records", "table.get_schema", "table.list_bases"]);
  });

  it("③ 读写（scope 更宽）-> 与只读同集合（S4 只落读工具；写工具随 S4 写片）", async () => {
    expect(await toolNames(tokens.readwrite!)).toEqual(["ping_echo", "record.list_records", "record.query_records", "table.get_schema", "table.list_bases"]);
  });

  it("④ 字段受限 -> 集合与只读同（字段级收窄体现在 schema/出参，见 m6-s4-read-tools）", async () => {
    expect(await toolNames(tokens.masked!)).toEqual(["ping_echo", "record.list_records", "record.query_records", "table.get_schema", "table.list_bases"]);
  });

  it("scope 粗筛：仅 doc:read 的 PAT 不见 record 族工具", async () => {
    expect(await toolNames(tokens.noScope!)).toEqual(["ping_echo"]);
  });
});

describe("S3 存在性不泄漏二分口径（golden）", () => {
  // 事实（SDK 1.30.0 实测，与计划措辞的差异见 docs/baseline 记录）：未知/未注册工具**不走 JSON-RPC error**，
  // 而是 HTTP 200 + result.isError=true，文案 `MCP error -32602: Tool <name> not found`（-32602 在文案内）。
  // 关键不变量：两种情形（被闸门裁掉 / 真不存在）除工具名外**逐字节一致**，不泄漏"该工具是否存在"。
  const TEMPLATE = (name: string) => `MCP error -32602: Tool ${name} not found`;

  it("被闸门裁掉的工具 vs 真不存在的工具：HTTP/键集合/isError/文案模板全一致", async () => {
    const gated = await call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "table.list_bases", arguments: {} } }, tokens.none!);
    const absent = await call({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "table.list_records", arguments: {} } }, tokens.none!);
    expect(gated.status).toBe(200);
    expect(absent.status).toBe(200);
    const g = await gated.json() as { result: { isError?: boolean; content: Array<{ type: string; text: string }> }; jsonrpc: string; id: number };
    const a = await absent.json() as typeof g;
    expect(Object.keys(g).sort()).toEqual(["id", "jsonrpc", "result"]); // 无 error 成员，形状固定
    expect(Object.keys(a).sort()).toEqual(Object.keys(g).sort());
    expect(g.result.isError).toBe(true);
    expect(a.result.isError).toBe(true);
    expect(g.result.content[0]!.text).toBe(TEMPLATE("table.list_bases"));
    expect(a.result.content[0]!.text).toBe(TEMPLATE("table.list_records"));
    // 归一化工具名后逐字节一致（除名字外零差异 -> 不泄漏存在性）
    const norm = (x: typeof g, name: string) => JSON.stringify(x).replaceAll(name, "<TOOL>");
    expect(norm(g, "table.list_bases")).toBe(norm(a, "table.list_records"));
  });

  it("可见主体直调真不存在工具 -> 同一口径（与是否可见无关）", async () => {
    const res = await call({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "table.list_records", arguments: {} } }, tokens.readonly!);
    const body = await res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(res.status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toBe(TEMPLATE("table.list_records"));
  });
});

describe("S3 IDOR：结果只含可见资源", () => {
  it("uFull 调 table.list_bases -> 仅 b1（b2 属他人可见集）", async () => {
    const res = await call({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "table.list_bases", arguments: {} } }, tokens.readonly!);
    const body = await res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.isError ?? false).toBe(false);
    const payload = JSON.parse(body.result.content[0]!.text) as { bases: Array<{ id: string }> };
    // S4 起 bases 为 {id,name} 对象
    expect(payload.bases.map((b) => b.id)).toEqual(["b1"]);
    expect(payload.bases.map((b) => b.id)).not.toContain("b2");
  });

  it("uOther 调 table.list_bases -> 仅 b2（各自可见集隔离）", async () => {
    const res = await call({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "table.list_bases", arguments: {} } }, tokens.other!);
    const payload = JSON.parse(((await res.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as { bases: Array<{ id: string }> };
    expect(payload.bases.map((b) => b.id)).toEqual(["b2"]);
  });
});
