// M6/S4 写工具验收（record.delete_record / C-6）：confirm 字面量、执行期 enforce d、软删与 REST 同语义
// （REST 侧同样不可见）、scope 粗筛（无 record:write 即不注册 -> UNKNOWN_TOOL）。

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
let tableId = "";
let rwToken = ""; // record:read + record:write
let roToken = ""; // 仅 record:read
let woToken = ""; // 仅 record:write（且 M4 侧只授 c,u,d、无 r）——只写身份
let maskedWToken = ""; // 读+建 + 字段白名单空 -> 任意字段写入应被 FORBIDDEN_FIELD 拒
const recordIds: string[] = [];

const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const call = (body: unknown, tok: string): Promise<Response> =>
  app.request("/mcp", { method: "POST", headers: { ...H, Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
async function callTool(name: string, args: Record<string, unknown>, tok: string) {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, tok);
  return { status: res.status, result: (await res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result };
}
async function names(tok: string): Promise<string[]> {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, tok);
  return ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name).sort();
}

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s4w-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s4w.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = "m6-s4w-secret-at-least-16-chars";
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_M5_SEARCH;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", { cwd: process.cwd(), stdio: "ignore", env: process.env });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  await prisma.user.create({ data: { id: "u1", email: "u1@x.com", displayName: "u1", passwordHash: "x", status: "ACTIVE" } });
  // 只写身份：策略仅授予 d（无 r）——用于验证裁决 (b)：写工具可达而读工具不可见
  await prisma.user.create({ data: { id: "u2", email: "u2@x.com", displayName: "u2", passwordHash: "x", status: "ACTIVE" } });
  await prisma.user.create({ data: { id: "u3", email: "u3@x.com", displayName: "u3", passwordHash: "x", status: "ACTIVE" } });
  const base = await prisma.base.create({ data: { id: "b1", name: "库一", createdBy: "u1" } });
  const table = await prisma.table.create({ data: { baseId: base.id, name: "表一", primaryFieldId: "", createdBy: "u1" } });
  tableId = table.id;
  const f1 = await prisma.field.create({ data: { tableId, name: "列", type: "singleLineText", order: 0 } });
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: f1.id } });
  for (let i = 0; i < 3; i++) {
    const r = await prisma.record.create({ data: { tableId, fields: JSON.stringify({ [f1.id]: `r${i}` }), createdBy: "u1", updatedBy: "u1" } });
    recordIds.push(r.id);
  }
  await createNavNodes(prisma, [
    { id: "nav_b1", kind: "base", resourceType: "base", resourceId: "b1" },
    { id: "nav_t1", kind: "table", resourceType: "table", resourceId: tableId, parentId: "nav_b1" },
  ]);
  await createPolicies(prisma, [
    { id: "p_b1", nodeId: "nav_b1", subjectType: "user", subjectId: "u1", actions: "r" },
    // 表级授予 r + c + u + d（MCP 写工具执行期做 d 判定）
    { id: "p_t1", nodeId: "nav_t1", subjectType: "user", subjectId: "u1", actions: "r,c,u,d" },
    { id: "p_t1_w", nodeId: "nav_t1", subjectType: "user", subjectId: "u2", actions: "c,u,d" },
    // u3：读+建 + 字段白名单（用于 FORBIDDEN_FIELD）
    { id: "p_t1_m", nodeId: "nav_t1", subjectType: "user", subjectId: "u3", actions: "r,c", fieldMask: JSON.stringify({ allowFields: [] }) },
  ]);
  const svc = await import("../../pat/patService.js");
  rwToken = (await svc.createPat("u1", { name: "rw", scopes: ["record:read", "record:write"], expiresInDays: 90 })).plaintext;
  roToken = (await svc.createPat("u1", { name: "ro", scopes: ["record:read"], expiresInDays: 90 })).plaintext;
  woToken = (await svc.createPat("u2", { name: "wo", scopes: ["record:write"], expiresInDays: 90 })).plaintext;
  maskedWToken = (await svc.createPat("u3", { name: "mw", scopes: ["record:read", "record:write"], expiresInDays: 90 })).plaintext;
  app = (await import("../../../app.js")).createApp().app as unknown as typeof app;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("S4 record.delete_record", () => {
  it("scope 粗筛：仅 record:read 的 PAT 无 delete_record（写工具不入册）", async () => {
    expect(await names(roToken)).not.toContain("record.delete_record");
    expect(await names(rwToken)).toContain("record.delete_record");
  });

  it("无 confirm / confirm=false -> -32602（zod4 literal 强制，破坏性操作必须显式确认）", async () => {
    for (const args of [{ tableId, recordId: recordIds[0]! }, { tableId, recordId: recordIds[0]!, confirm: false }]) {
      const r = await callTool("record.delete_record", args, rwToken);
      expect(r.status).toBe(200);
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0]!.text).toContain("-32602");
    }
    // 未被误删
    expect((await prisma.record.findUniqueOrThrow({ where: { id: recordIds[0]! } })).deletedAt).toBeNull();
  });

  it("只读 PAT 直调 delete_record -> UNKNOWN_TOOL（未注册，不泄漏存在性）", async () => {
    const r = await callTool("record.delete_record", { tableId, recordId: recordIds[0]!, confirm: true }, roToken);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain("-32602");
    expect((await prisma.record.findUniqueOrThrow({ where: { id: recordIds[0]! } })).deletedAt).toBeNull();
  });

  it("confirm=true -> 软删成功；且 **REST 侧读同语义不可见**（MCP list_records 与直查均已排除）", async () => {
    const target = recordIds[1]!;
    const r = await callTool("record.delete_record", { tableId, recordId: target, confirm: true }, rwToken);
    expect(r.result.isError ?? false).toBe(false);
    expect(JSON.parse(r.result.content[0]!.text).ok).toBe(true);
    // 库内：deletedAt 已置（软删而非物理删）
    const row = await prisma.record.findUniqueOrThrow({ where: { id: target } });
    expect(row.deletedAt).not.toBeNull();
    // MCP 读侧不可见
    const list = await callTool("record.list_records", { tableId, limit: 10 }, rwToken);
    const ids = (JSON.parse(list.result.content[0]!.text) as { records: Array<{ id?: string }> }).records.map((x) => x.id);
    expect(ids).not.toContain(target);
    // REST 同语义（路由按 deletedAt=null 过滤）——直查等价断言
    const visible = await prisma.record.count({ where: { tableId, deletedAt: null } });
    expect(visible).toBe(2);
  });

  it("不存在/已删/跨表 recordId -> FORBIDDEN_RESOURCE（不泄漏存在性）", async () => {
    for (const recordId of ["no_such", recordIds[1]!]) {
      const r = await callTool("record.delete_record", { tableId, recordId, confirm: true }, rwToken);
      expect(r.result.isError).toBe(true);
      expect(JSON.parse(r.result.content[0]!.text).code).toBe("FORBIDDEN_RESOURCE");
    }
  });
});

describe("S4 裁决 (b)：动作敏感闸门一（只写身份）", () => {
  it("只写身份 tools/list **恰为写工具**（无任何读工具）——注册集 == 有效动作集", async () => {
    expect(await names(woToken)).toEqual(["ping_echo", "record.create_record", "record.delete_record"]);
  });

  it("只写身份直调读工具 -> UNKNOWN_TOOL（未注册，不越权）", async () => {
    for (const tool of ["record.list_records", "record.query_records", "table.get_schema", "table.list_bases"]) {
      const r = await callTool(tool, { tableId }, woToken);
      expect(r.status).toBe(200);
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0]!.text).toContain("-32602");
    }
  });

  it("只写身份删除成功且回执为**精简 {ok:true}**（无 recordId/deleted/字段映射，防派生值泄漏）", async () => {
    const rec = await prisma.record.create({
      data: { tableId, fields: JSON.stringify({}), createdBy: "u2", updatedBy: "u2" },
    });
    const r = await callTool("record.delete_record", { tableId, recordId: rec.id, confirm: true }, woToken);
    expect(r.result.isError ?? false).toBe(false);
    const payload = JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
    expect(payload).toEqual({ ok: true });           // 精确形状：无任何附加键
    expect(Object.keys(payload)).toEqual(["ok"]);
    expect((await prisma.record.findUniqueOrThrow({ where: { id: rec.id } })).deletedAt).not.toBeNull();
  });
});

describe("S4 record.create_record", () => {
  it("无 confirm -> -32602；confirm=true -> 创建成功且 REST 侧可见（list_records 能读到）", async () => {
    const noConfirm = await callTool("record.create_record", { tableId, fields: {} }, rwToken);
    expect(noConfirm.result.isError).toBe(true);
    expect(noConfirm.result.content[0]!.text).toContain("-32602");

    const before = await prisma.record.count({ where: { tableId, deletedAt: null } });
    const r = await callTool("record.create_record", { tableId, fields: {}, confirm: true }, rwToken);
    expect(r.result.isError ?? false).toBe(false);
    expect(JSON.parse(r.result.content[0]!.text).ok).toBe(true);
    expect(await prisma.record.count({ where: { tableId, deletedAt: null } })).toBe(before + 1);
    const list = await callTool("record.list_records", { tableId, limit: 50 }, rwToken);
    expect((JSON.parse(list.result.content[0]!.text) as { records: unknown[] }).records.length).toBe(before + 1);
  });

  it("字段级：字段受限身份写白名单外字段 -> FORBIDDEN_FIELD（整单拒绝，不静默丢弃）", async () => {
    const r = await callTool("record.create_record", { tableId, fields: { fld_x: "v" }, confirm: true }, maskedWToken);
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0]!.text).code).toBe("FORBIDDEN_FIELD");
  });

  it("只写身份创建成功且回执为**精简 {ok:true}**（无 recordId/字段映射）", async () => {
    const r = await callTool("record.create_record", { tableId, fields: {}, confirm: true }, woToken);
    expect(r.result.isError ?? false).toBe(false);
    expect(JSON.parse(r.result.content[0]!.text)).toEqual({ ok: true });
  });
});
