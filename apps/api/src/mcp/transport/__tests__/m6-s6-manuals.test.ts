// M6/S6 三份语言说明书验收：
//   ① 只读 doc:read 的 PAT 可列出并读取三份 Resources（不挂 scope 门），markdown 非空且含预期小节标题；
//   ② **不泄漏业务数据**：夹具里独有名字不出现在说明书文本与 tools/list 响应中；
//   ③ **一致性护栏**：说明书中出现的工具名必须都在 TOOL_CATALOG；目录中除 ping_echo 外每个工具都被提到。

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

// 探针名：这些是"业务数据"，绝不能出现在说明书/工具清单里
const PROBE_BASE = "探针库_勿泄漏";
const PROBE_TABLE = "探针表_勿泄漏";
const PROBE_DOC = "探针文档_勿泄漏";

let tmpDir: string;
let prisma: PrismaClient;
let app: { request: (u: string, i?: RequestInit) => Promise<Response> };
let roToken = ""; // 仅 doc:read（无任何表/画布 scope）
let MANUAL_RESOURCES: ReadonlyArray<{ name: string; uri: string; mimeType: string; text: string }>;
let TOOL_CATALOG: ReadonlyArray<{ meta: { name: string } }>;

const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const call = (body: unknown, tok: string): Promise<Response> =>
  app.request("/mcp", { method: "POST", headers: { ...H, Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });

async function rpc(method: string, params: unknown, tok: string) {
  const res = await call({ jsonrpc: "2.0", id: 1, method, params }, tok);
  const body = await res.json() as { result: any };
  return { status: res.status, result: body.result };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s6-manuals-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s6man.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = "m6-s6-manuals-secret-at-least-16";
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_M5_SEARCH;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", { cwd: process.cwd(), stdio: "ignore", env: process.env });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  await prisma.user.create({ data: { id: "u1", email: "u1@x.com", displayName: "u1", passwordHash: "x", status: "ACTIVE" } });
  // 业务数据夹具（仅用于"不泄漏"断言）
  const kb = await prisma.knowledgeBase.create({ data: { id: "kb1", name: PROBE_BASE, createdBy: "owner0" } });
  const base = await prisma.base.create({ data: { id: "b1", name: PROBE_BASE, createdBy: "owner0" } });
  await prisma.table.create({ data: { baseId: base.id, name: PROBE_TABLE, primaryFieldId: "", createdBy: "owner0" } });
  const doc = await prisma.kbDoc.create({
    data: { kbId: kb.id, kind: "doc", title: PROBE_DOC, content: "# 探针内容", createdBy: "owner0", updatedBy: "owner0" },
  });
  await createNavNodes(prisma, [
    { id: nodeId("kb", kb.id), kind: "kb", resourceType: "kb", resourceId: kb.id },
    { id: nodeId("doc", doc.id), kind: "doc", resourceType: "doc", resourceId: doc.id, parentId: nodeId("kb", kb.id) },
  ]);
  await createPolicies(prisma, [
    { id: "p_doc", nodeId: nodeId("doc", doc.id), subjectType: "user", subjectId: "u1", actions: "r" },
  ]);
  const svc = await import("../../pat/patService.js");
  roToken = (await svc.createPat("u1", { name: "ro", scopes: ["doc:read"], expiresInDays: 90 })).plaintext;

  app = (await import("../../../app.js")).createApp().app as unknown as typeof app;
  // 惰性动态导入（catalog 会触发 config 顶层闸门，须在 env 就绪后加载）
  MANUAL_RESOURCES = (await import("../../tools/manuals.js")).MANUAL_RESOURCES;
  TOOL_CATALOG = (await import("../../tools/catalog.js")).TOOL_CATALOG;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("S6 说明书 Resources（只读 PAT 可读，不挂 scope 门）", () => {
  it("resources/list 返回三份说明书（含 mimeType=text/markdown）", async () => {
    const { status, result } = await rpc("resources/list", {}, roToken);
    expect(status).toBe(200);
    const uris = (result.resources as Array<{ uri: string; mimeType?: string }>).map((r) => r.uri).sort();
    expect(uris).toEqual(["gx://manuals/blocks", "gx://manuals/canvas", "gx://manuals/table"]);
    for (const r of result.resources as Array<{ mimeType?: string }>) expect(r.mimeType).toBe("text/markdown");
  });

  it("resources/read 逐份可读：markdown 非空且含预期标题", async () => {
    const expectTitle: Record<string, string> = {
      "gx://manuals/table": "# 表与记录语言",
      "gx://manuals/blocks": "# 文档块语言",
      "gx://manuals/canvas": "# 画布图元语言",
    };
    for (const [uri, title] of Object.entries(expectTitle)) {
      const { result } = await rpc("resources/read", { uri }, roToken);
      const contents = result.contents as Array<{ uri: string; mimeType?: string; text: string }>;
      expect(contents.length).toBe(1);
      expect(contents[0]!.uri).toBe(uri);
      expect(contents[0]!.mimeType).toBe("text/markdown");
      expect(contents[0]!.text.trim().length).toBeGreaterThan(0);
      expect(contents[0]!.text).toContain(title);
    }
  });
});

describe("S6 说明书不泄漏业务数据", () => {
  it("三份说明书文本均不含任何业务夹具名", async () => {
    for (const m of MANUAL_RESOURCES) {
      for (const probe of [PROBE_BASE, PROBE_TABLE, PROBE_DOC]) {
        expect(m.text, `${m.uri} 泄漏了 ${probe}`).not.toContain(probe);
      }
    }
  });

  it("tools/list 响应（tool 名/描述）不含任何业务夹具名", async () => {
    const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, roToken);
    const raw = JSON.stringify(await res.json());
    for (const probe of [PROBE_BASE, PROBE_TABLE, PROBE_DOC]) {
      expect(raw, `tools/list 泄漏了 ${probe}`).not.toContain(probe);
    }
  });
});

describe("S6 说明书与 TOOL_CATALOG 一致性护栏", () => {
  /** 抽取说明书中的工具名（仅 table/record/doc/canvas 前缀，避免误抓 element.create 等操作名）。 */
  function extractToolNames(text: string): string[] {
    const out = new Set<string>();
    const re = /(?:^|[^A-Za-z0-9_])((?:table|record|doc|canvas)\.[a-z][a-z_]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.add(m[1]!);
    return [...out];
  }

  it("说明书中出现的每个工具名都真实存在于 TOOL_CATALOG", () => {
    const catalog = new Set(TOOL_CATALOG.map((t) => t.meta.name));
    const unknown: string[] = [];
    for (const m of MANUAL_RESOURCES) {
      for (const name of extractToolNames(m.text)) if (!catalog.has(name)) unknown.push(`${m.uri}: ${name}`);
    }
    expect(unknown).toEqual([]);
    // 反证：抽取确实抓到了工具名（非空守卫，避免正则失效导致假绿）
    const all = MANUAL_RESOURCES.flatMap((m) => extractToolNames(m.text));
    expect(all.length).toBeGreaterThan(5);
  });

  it("TOOL_CATALOG 中除连接性 ping_echo 外，每个工具都至少被一份说明书提到", () => {
    const mentioned = new Set(MANUAL_RESOURCES.flatMap((m) => extractToolNames(m.text)));
    const missing = TOOL_CATALOG.map((t) => t.meta.name).filter((n) => n !== "ping_echo" && !mentioned.has(n));
    expect(missing).toEqual([]);
  });

  // 时序一致性（S6 只读片特有，防"说明书用现在时宣称一个尚未注册的操作"——本次复验真抓到：
  // 原画布说明书同时写"当前支持写入最小集 element.create"与"当前画布能力为只读"，自相矛盾，
  // 而 element.create 要到 S6b 才随 canvas.commit_elements 注册）。
  it("画布说明书在只读期不得宣称写入已上线：须明示尚无写入工具、element.create 尚未注册", () => {
    const canvas = MANUAL_RESOURCES.find((m) => m.uri === "gx://manuals/canvas")!.text;
    expect(canvas).toContain("尚无写入工具");
    expect(canvas).toContain("尚未注册");
    // 【S6b 挂账】canvas.commit_elements 上线后，把 element.create 描述移回"当前支持"并更新本断言；
    // 同时 S9 出口收口时核对三份说明书的时态与 TOOL_CATALOG 完全一致。
    expect(TOOL_CATALOG.some((t) => t.meta.name === "canvas.commit_elements")).toBe(false);
  });
});
