// M6/S4 表/记录读工具路由级验收（真 app + 真 M4 夹具 + 真 PAT + 真 records 数据）。
// 覆盖：tools/list 含读工具（M5 off 时 record.search 缺席）；list_bases 带名；get_schema 字段收窄；
// list_records 不可见字段物理缺席；limit 201 / 非法算子 -> -32602；不可见表 -> FORBIDDEN_RESOURCE。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { createNavNodes, createPolicies } from "../../../domain/authz/__tests__/engineHarness.js";

const ENV_KEYS = ["DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV",
  "GX_RATE_LIMIT", "GX_ENTERPRISE_ORG", "GX_M5_SEARCH"] as const;
const PREV: Record<string, string | undefined> = {};

let tmpDir: string;
let prisma: PrismaClient;
let app: { request: (u: string, i?: RequestInit) => Promise<Response> };
let token = "";
let tableId = "";

const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const call = (body: unknown, tok = token): Promise<Response> =>
  app.request("/mcp", { method: "POST", headers: { ...H, Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });

async function toolNames(): Promise<string[]> {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const b = await res.json() as { result: { tools: Array<{ name: string }> } };
  return b.result.tools.map((t) => t.name).sort();
}
async function callTool(name: string, args: Record<string, unknown>): Promise<{ status: number; result: { isError?: boolean; content: Array<{ text: string }> } }> {
  const res = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  return { status: res.status, result: (await res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s4-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s4.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = "m6-s4-secret-at-least-16-chars";
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_M5_SEARCH; // M5 off -> record.search 不注册
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", { cwd: process.cwd(), stdio: "ignore", env: process.env });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  await prisma.user.create({ data: { id: "u1", email: "u1@x.com", displayName: "u1", passwordHash: "x", status: "ACTIVE" } });
  const base = await prisma.base.create({ data: { id: "b1", name: "库一", createdBy: "u1" } });
  const table = await prisma.table.create({ data: { baseId: base.id, name: "表一", primaryFieldId: "", createdBy: "u1" } });
  tableId = table.id;
  const f1 = await prisma.field.create({ data: { tableId, name: "可见列", type: "singleLineText", order: 0 } });
  const f2 = await prisma.field.create({ data: { tableId, name: "隐藏列", type: "singleLineText", order: 1 } });
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: f1.id } });
  await prisma.record.createMany({
    data: [0, 1, 2].map((i) => ({
      tableId, fields: JSON.stringify({ [f1.id]: `r${i}`, [f2.id]: `hidden${i}` }),
      createdBy: "u1", updatedBy: "u1", createdAt: new Date(Date.UTC(2026, 0, 1 + i)), updatedAt: new Date(Date.UTC(2026, 0, 1 + i)),
    })),
  });
  // 另一库（对 u1 不可见），用于 FORBIDDEN_RESOURCE
  const base2 = await prisma.base.create({ data: { id: "b2", name: "库二", createdBy: "u2" } });
  await prisma.user.create({ data: { id: "u2", email: "u2@x.com", displayName: "u2", passwordHash: "x", status: "ACTIVE" } });
  const t2 = await prisma.table.create({ data: { baseId: base2.id, name: "表二", primaryFieldId: "", createdBy: "u2" } });

  await createNavNodes(prisma, [
    { id: "nav_b1", kind: "base", resourceType: "base", resourceId: "b1" },
    { id: "nav_t1", kind: "table", resourceType: "table", resourceId: tableId, parentId: "nav_b1" },
    { id: "nav_b2", kind: "base", resourceType: "base", resourceId: "b2" },
    { id: "nav_t2", kind: "table", resourceType: "table", resourceId: t2.id, parentId: "nav_b2" },
  ]);
  await createPolicies(prisma, [
    // base 与 table 两层都用同一字段白名单（若祖先给无掩码 r，M4 语义为「宽来源胜出」-> 不收窄）
    { id: "p_b1", nodeId: "nav_b1", subjectType: "user", subjectId: "u1", actions: "r", fieldMask: JSON.stringify({ allowFields: [f1.id] }) },
    // 表级 r + 字段白名单（仅 f1 可见）-> schema 收窄 + 出参物理缺席
    { id: "p_t1", nodeId: "nav_t1", subjectType: "user", subjectId: "u1", actions: "r", fieldMask: JSON.stringify({ allowFields: [f1.id] }) },
  ]);

  const svc = await import("../../pat/patService.js");
  token = (await svc.createPat("u1", { name: "s4", scopes: ["record:read"], expiresInDays: 90 })).plaintext;
  app = (await import("../../../app.js")).createApp().app as unknown as typeof app;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("S4 读工具注册与可见性", () => {
  // 语义适配（P3）：写工具是否入册改由【签发者的实际动作】决定——u1 是 b1/表一的创建者，
  // 创建者兜底带出 c/u/d，故写工具也在册。原断言（"只读身份只有 4 件读工具"）的判据是令牌 scope，
  // 已随新口径失效；这里改盯"读工具齐备 + record.search 仍被总门挡住"。
  it("tools/list 含 4 读工具（写工具按签发者动作入册）；M5 off 时 record.search 缺席（运行期可用性门）", async () => {
    const names = await toolNames();
    for (const t of ["record.list_records", "record.query_records", "table.get_schema", "table.list_bases"]) {
      expect(names).toContain(t);
    }
    expect(names).not.toContain("record.search");
    expect(names).toContain("ping_echo");
  });
});

describe("S4 table.list_bases / table.get_schema", () => {
  it("list_bases 带 name（仅可见 base）", async () => {
    const r = await callTool("table.list_bases", {});
    expect(JSON.parse(r.result.content[0]!.text)).toEqual({ bases: [{ id: "b1", name: "库一" }], truncated: false });
  });

  it("get_schema：只出可见表与可见字段（隐藏列不进 schema，AC-M6-2）", async () => {
    const r = await callTool("table.get_schema", { baseId: "b1" });
    const payload = JSON.parse(r.result.content[0]!.text) as { tables: Array<{ tableId: string; fields: Array<{ name: string }> }> };
    expect(payload.tables.map((t) => t.tableId)).toEqual([tableId]);
    expect(payload.tables[0]!.fields.map((f) => f.name)).toEqual(["可见列"]);
  });

  it("不可见 base -> FORBIDDEN_RESOURCE（isError，不泄漏存在性细节）", async () => {
    const r = await callTool("table.get_schema", { baseId: "b2" });
    expect(r.status).toBe(200);
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0]!.text).code).toBe("FORBIDDEN_RESOURCE");
  });
});

describe("S4 record.list_records（物理缺席 + 配额）", () => {
  it("返回记录中不可见字段物理缺席（fields 只含可见列）", async () => {
    const r = await callTool("record.list_records", { tableId, limit: 10 });
    const payload = JSON.parse(r.result.content[0]!.text) as { records: Array<{ fields: Record<string, string> }> };
    expect(payload.records).toHaveLength(3);
    for (const rec of payload.records) {
      expect(Object.keys(rec.fields)).toHaveLength(1);
      expect(Object.values(rec.fields)[0]).toMatch(/^r[0-2]$/);
      expect(JSON.stringify(rec.fields)).not.toContain("hidden");
    }
  });

  it("limit=201 -> -32602（zod4 入参校验，HTTP 200 + isError）", async () => {
    const r = await callTool("record.list_records", { tableId, limit: 201 });
    expect(r.status).toBe(200);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain("-32602");
  });

  it("不可见表 -> FORBIDDEN_RESOURCE", async () => {
    const r = await callTool("record.list_records", { tableId: "no_such_table" });
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0]!.text).code).toBe("FORBIDDEN_RESOURCE");
  });
});

describe("S4 record.query_records（受控 filter）", () => {
  it("合法算子过滤 -> 命中 1 行", async () => {
    const r = await callTool("record.query_records", { tableId, filter: [{ fieldId: "fld_visible", op: "is", value: "r1" }] });
    // fieldId 需真实：从 schema 取
    void r;
    const schema = await callTool("table.get_schema", { baseId: "b1" });
    const fid = (JSON.parse(schema.result.content[0]!.text) as { tables: Array<{ fields: Array<{ fieldId: string }> }> }).tables[0]!.fields[0]!.fieldId;
    const r2 = await callTool("record.query_records", { tableId, filter: [{ fieldId: fid, op: "is", value: "r1" }] });
    const payload = JSON.parse(r2.result.content[0]!.text) as { records: Array<{ fields: Record<string, string> }> };
    expect(payload.records).toHaveLength(1);
    expect(Object.values(payload.records[0]!.fields)[0]).toBe("r1");
  });

  it("非法算子 -> -32602（白名单外一律拒，禁任意 SQL/公式）", async () => {
    const r = await callTool("record.query_records", { tableId, filter: [{ fieldId: "x", op: "rawSql", value: "1=1" }] });
    expect(r.status).toBe(200);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain("-32602");
  });
});
