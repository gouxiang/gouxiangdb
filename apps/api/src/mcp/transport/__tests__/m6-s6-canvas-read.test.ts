// M6/S6 canvas 只读工具验收（骨架仿 m6-s5-doc-tools.test.ts：真 app + 真 M4 夹具 + 真 PAT）：
//   scope 粗筛（canvas:read vs doc:read）、未注册直调 UNKNOWN_TOOL、无权/类型不匹配拒、
//   未知键透传不剥离、空/坏/非数组 content 不抛错、contentVersion 与 DB 一致。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { createNavNodes, createPolicies } from "../../../domain/authz/__tests__/engineHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";

const ENV_KEYS = ["DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV",
  "GX_RATE_LIMIT", "GX_ENTERPRISE_ORG", "GX_M5_SEARCH"] as const;
const PREV: Record<string, string | undefined> = {};

let tmpDir: string;
let prisma: PrismaClient;
let app: { request: (u: string, i?: RequestInit) => Promise<Response> };
let canvasToken = ""; // canvas:read
let docToken = "";    // doc:read（同为 u1 签发：用于证明 scope 不再影响注册集）
let noCanvasToken = ""; // u2 签发：u2 无任何画布策略 -> canvas 族不可见
let c1 = "";  // 正常画布（含未知键 + 箭头元素）
let c2 = "";  // content ""
let c3 = "";  // 坏 JSON
let c4 = "";  // 顶层非数组
let d1 = "";  // kind=doc 但挂了 canvas 型 nav 节点（覆盖 kind 守卫）
let cHidden = ""; // 有 canvas 节点但无策略（不可见）

const ELEM = [
  { id: "rect1", type: "geometry", shape: "rectangle", points: [[0, 0], [100, 0], [100, 60], [0, 60]], text: "节点", __unknownKey: { a: 1 } },
  { id: "l1", type: "arrow-line", shape: "straight", points: [[100, 30], [200, 30]], source: { marker: "none" }, target: { marker: "arrow" }, texts: [] },
];

const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const call = (body: unknown, tok: string): Promise<Response> =>
  app.request("/mcp", { method: "POST", headers: { ...H, Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
async function callTool(name: string, args: Record<string, unknown>, tok: string) {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, tok);
  return { status: res.status, result: (await res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result };
}
const board = (docId: string, tok = canvasToken) => callTool("canvas.get_board", { docId }, tok);
const toolsOf = async (tok: string): Promise<string[]> => {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, tok);
  return ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
};
const payloadOf = (text: string) => JSON.parse(text) as { docId: string; elementCount: number; elements: Array<Record<string, unknown>>; viewport: unknown; parseError: boolean; contentVersion: number };

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s6-cv-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s6cv.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = "m6-s6-canvas-secret-at-least-16";
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_M5_SEARCH;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", { cwd: process.cwd(), stdio: "ignore", env: process.env });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  await prisma.user.create({ data: { id: "u1", email: "u1@x.com", displayName: "u1", passwordHash: "x", status: "ACTIVE" } });
  // u2：不授予任何画布策略——P3 起「某工具是否入册」的判据是签发者的实际授权，需要一个反例主体。
  await prisma.user.create({ data: { id: "u2", email: "u2@x.com", displayName: "u2", passwordHash: "x", status: "ACTIVE" } });
  // creator 置外部用户，避免 creator 兜底 UNION 干扰策略驱动断言
  const kb = await prisma.knowledgeBase.create({ data: { id: "kb1", name: "库一", createdBy: "owner0" } });
  const mkCanvas = async (content: string, title: string) =>
    (await prisma.kbDoc.create({ data: { kbId: kb.id, kind: "canvas", title, content, createdBy: "owner0", updatedBy: "owner0" } })).id;
  c1 = await mkCanvas(JSON.stringify(ELEM), "画布一");
  c2 = await mkCanvas("", "空画布");
  c3 = await mkCanvas("{ not json", "坏画布");
  c4 = await mkCanvas("{}", "对象画布");
  cHidden = await mkCanvas(JSON.stringify([]), "隐藏画布");
  // kind=doc 却挂 canvas 型节点：仅用于覆盖"kind 不匹配"守卫
  d1 = (await prisma.kbDoc.create({ data: { kbId: kb.id, kind: "doc", title: "文档一", content: "秘密", createdBy: "owner0", updatedBy: "owner0" } })).id;

  await createNavNodes(prisma, [
    { id: nodeId("kb", "kb1"), kind: "kb", resourceType: "kb", resourceId: "kb1" },
    { id: nodeId("canvas", c1), kind: "canvas", resourceType: "canvas", resourceId: c1, parentId: nodeId("kb", "kb1") },
    { id: nodeId("canvas", c2), kind: "canvas", resourceType: "canvas", resourceId: c2, parentId: nodeId("kb", "kb1") },
    { id: nodeId("canvas", c3), kind: "canvas", resourceType: "canvas", resourceId: c3, parentId: nodeId("kb", "kb1") },
    { id: nodeId("canvas", c4), kind: "canvas", resourceType: "canvas", resourceId: c4, parentId: nodeId("kb", "kb1") },
    { id: nodeId("canvas", cHidden), kind: "canvas", resourceType: "canvas", resourceId: cHidden, parentId: nodeId("kb", "kb1") },
    { id: nodeId("canvas", d1), kind: "canvas", resourceType: "canvas", resourceId: d1, parentId: nodeId("kb", "kb1") },
  ]);
  await createPolicies(prisma, [
    // 不在 kb 节点授 r（避免祖先并集下传到全部画布）
    { id: "p_c1", nodeId: nodeId("canvas", c1), subjectType: "user", subjectId: "u1", actions: "r" },
    { id: "p_c2", nodeId: nodeId("canvas", c2), subjectType: "user", subjectId: "u1", actions: "r" },
    { id: "p_c3", nodeId: nodeId("canvas", c3), subjectType: "user", subjectId: "u1", actions: "r" },
    { id: "p_c4", nodeId: nodeId("canvas", c4), subjectType: "user", subjectId: "u1", actions: "r" },
    { id: "p_dc1", nodeId: nodeId("canvas", d1), subjectType: "user", subjectId: "u1", actions: "r" },
    // cHidden 不授任何策略 -> 不可见
  ]);

  const svc = await import("../../pat/patService.js");
  canvasToken = (await svc.createPat("u1", { name: "cv", scopes: ["canvas:read"], expiresInDays: 90 })).plaintext;
  docToken = (await svc.createPat("u1", { name: "dc", scopes: ["doc:read"], expiresInDays: 90 })).plaintext;
  noCanvasToken = (await svc.createPat("u2", { name: "nc", scopes: ["canvas:read"], expiresInDays: 90 })).plaintext;
  app = (await import("../../../app.js")).createApp().app as unknown as typeof app;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("S6 canvas.get_board 注册与 scope 粗筛", () => {
  // 语义适配（P3）：两枚令牌同为 u1 签发，scope 已不参与判定——故 docToken 也能看到 canvas 工具。
  it("doc:read 的 PAT 与 canvas:read 的 PAT 注册集一致（同为 u1 签发，scope 不再粗筛）", async () => {
    const a = (await toolsOf(canvasToken)).sort();
    const b = (await toolsOf(docToken)).sort();
    expect(a).toEqual(b);
    expect(a).toContain("canvas.get_board");
  });

  // 「未注册 -> UNKNOWN_TOOL」的不变量原样保留，判据换成"签发者对该画布无 r"：
  // u2 无任何画布策略 -> canvas 族可见集为空 -> canvas.get_board 不入册。
  it("签发者无画布读权限 -> 看不到 canvas.get_board（族可见集为空）", async () => {
    expect(await toolsOf(noCanvasToken)).not.toContain("canvas.get_board");
  });

  it("未注册工具直调 -> UNKNOWN_TOOL（文本含 -32602）", async () => {
    const r = await board(c1, noCanvasToken);
    expect(r.status).toBe(200);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain("-32602");
  });
});

describe("S6 canvas.get_board 可见性与类型守卫", () => {
  it("不可见画布（无策略）-> FORBIDDEN_RESOURCE（不泄漏存在性）", async () => {
    const r = await board(cHidden);
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0]!.text).code).toBe("FORBIDDEN_RESOURCE");
  });

  it("传 doc 类 docId（虽有 canvas 型节点）-> kind 不匹配，FORBIDDEN_RESOURCE（拿不到正文）", async () => {
    const r = await board(d1);
    expect(r.result.isError).toBe(true);
    const text = r.result.content[0]!.text;
    expect(JSON.parse(text).code).toBe("FORBIDDEN_RESOURCE");
    expect(text).not.toContain("秘密"); // 绝不放行文档正文
  });

  it("完全不存在的 docId -> FORBIDDEN_RESOURCE", async () => {
    const r = await board("no_such_canvas");
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0]!.text).code).toBe("FORBIDDEN_RESOURCE");
  });
});

describe("S6 canvas.get_board 元素透传与容错", () => {
  it("正常画布：elementCount 与元素数一致；**未知键原样透传**（不剥离）", async () => {
    const r = await board(c1);
    expect(r.result.isError ?? false).toBe(false);
    const p = payloadOf(r.result.content[0]!.text);
    expect(p.elementCount).toBe(ELEM.length);
    expect(p.elements.length).toBe(ELEM.length);
    // __unknownKey 原样存在（防"悄悄剥离"）
    expect(p.elements[0]!.__unknownKey).toEqual({ a: 1 });
    // 箭头元素（含 source/target 绑定结构）也原样返回
    expect(p.elements[1]!.type).toBe("arrow-line");
    expect((p.elements[1]!.target as { marker: string }).marker).toBe("arrow");
    // viewport 未持久化 -> 如实 null
    expect(p.viewport).toBeNull();
  });

  it("content=\"\" -> elements: [] / elementCount: 0，不报错、非 parseError", async () => {
    const r = await board(c2);
    expect(r.result.isError ?? false).toBe(false);
    const p = payloadOf(r.result.content[0]!.text);
    expect(p.elements).toEqual([]);
    expect(p.elementCount).toBe(0);
    expect(p.parseError).toBe(false);
  });

  it("坏 JSON -> 不抛错，elements: []，parseError: true", async () => {
    const r = await board(c3);
    expect(r.result.isError ?? false).toBe(false);
    const p = payloadOf(r.result.content[0]!.text);
    expect(p.elements).toEqual([]);
    expect(p.elementCount).toBe(0);
    expect(p.parseError).toBe(true);
  });

  it("顶层非数组（对象）-> 不抛错，elements: []，parseError: true", async () => {
    const r = await board(c4);
    expect(r.result.isError ?? false).toBe(false);
    const p = payloadOf(r.result.content[0]!.text);
    expect(p.elements).toEqual([]);
    expect(p.parseError).toBe(true);
  });

  it("contentVersion 与 DB 一致", async () => {
    const row = await prisma.kbDoc.findUniqueOrThrow({ where: { id: c1 } });
    const p = payloadOf((await board(c1)).result.content[0]!.text);
    expect(p.contentVersion).toBe(row.contentVersion);
    expect(p.docId).toBe(c1);
  });
});
