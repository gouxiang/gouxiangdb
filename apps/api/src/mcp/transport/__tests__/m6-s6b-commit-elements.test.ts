// M6/S6b canvas.commit_elements 验收（骨架仿 m6-s5-doc-tools.test.ts：真 app + 真 M4 夹具 + 真 PAT）：
//   scope 粗筛（canvas:read 看不到 / canvas:write 只写身份看得到且恰含 commit+ping）、
//   未注册直调 UNKNOWN_TOOL、三矩形尾插成功 + 服务端 id + get_board 往返 + version+1、
//   confirm 拦截、六类坏输入各自 code 且 DB 逐字节未变（原子）、宽高非正、
//   乐观锁 VERSION_CONFLICT 与只写身份 LWW 精简回执、FORBIDDEN_RESOURCE、普通键透传/gx* 拒绝、10MB 上限。
//
// 元素结构权威判定在 @gx/canvas（纯函数另测）；本文件只验协议/鉴权/事务/往返。

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
let c1 = "";   // 可见画布（u1 r,u）
let c2 = "";   // 不可见画布（无策略）
let d1 = "";   // kind=doc 但挂 canvas 型节点（覆盖 kind 守卫）
let rwToken = ""; // canvas:read + canvas:write
let roToken = ""; // 仅 canvas:read
let woToken = ""; // 仅 canvas:write（只写身份）

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
const row = () => prisma.kbDoc.findUniqueOrThrow({ where: { id: c1 } });
const rect = (extra: Record<string, unknown> = {}) => ({
  type: "geometry", shape: "rectangle", points: [[0, 0], [100, 80]], ...extra,
});
const commit = (args: Record<string, unknown>, tok = rwToken) =>
  callTool("canvas.commit_elements", args, tok);
/** 读回画布元素（经协议，不直读 prisma 内容）。 */
async function boardElements(tok = rwToken) {
  const r = await callTool("canvas.get_board", { docId: c1 }, tok);
  return JSON.parse(r.result.content[0]!.text) as {
    elementCount: number; contentVersion: number;
    elements: Array<Record<string, unknown>>;
  };
}

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s6b-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s6b.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = "m6-s6b-canvas-secret-at-least-16";
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_M5_SEARCH;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", { cwd: process.cwd(), stdio: "ignore", env: process.env });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;

  for (const id of ["u1", "u2", "u3", "owner0"]) {
    await prisma.user.create({ data: { id, email: `${id}@x.com`, displayName: id, passwordHash: "x", status: "ACTIVE" } });
  }
  const kb = await prisma.knowledgeBase.create({ data: { id: "kb1", name: "库一", createdBy: "owner0" } });
  const seed = JSON.stringify([{ id: "seed0", type: "geometry", shape: "rectangle", points: [[0, 0], [10, 10]] }]);
  c1 = (await prisma.kbDoc.create({ data: { kbId: kb.id, kind: "canvas", title: "画布一", content: seed, createdBy: "owner0", updatedBy: "owner0" } })).id;
  c2 = (await prisma.kbDoc.create({ data: { kbId: kb.id, kind: "canvas", title: "画布二", content: "[]", createdBy: "owner0", updatedBy: "owner0" } })).id;
  d1 = (await prisma.kbDoc.create({ data: { kbId: kb.id, kind: "doc", title: "文档一", content: "秘密", createdBy: "owner0", updatedBy: "owner0" } })).id;

  await createNavNodes(prisma, [
    { id: nodeId("kb", "kb1"), kind: "kb", resourceType: "kb", resourceId: "kb1" },
    { id: nodeId("canvas", c1), kind: "canvas", resourceType: "canvas", resourceId: c1, parentId: nodeId("kb", "kb1") },
    { id: nodeId("canvas", c2), kind: "canvas", resourceType: "canvas", resourceId: c2, parentId: nodeId("kb", "kb1") },
    { id: nodeId("canvas", d1), kind: "canvas", resourceType: "canvas", resourceId: d1, parentId: nodeId("kb", "kb1") },
  ]);
  await createPolicies(prisma, [
    // 不在 kb 节点授权（避免祖先并集下传到全部画布）
    { id: "p_c1_rw", nodeId: nodeId("canvas", c1), subjectType: "user", subjectId: "u1", actions: "r,u" },
    { id: "p_c1_ro", nodeId: nodeId("canvas", c1), subjectType: "user", subjectId: "u3", actions: "r" },
    { id: "p_c1_wo", nodeId: nodeId("canvas", c1), subjectType: "user", subjectId: "u2", actions: "u" },
    { id: "p_dc1", nodeId: nodeId("canvas", d1), subjectType: "user", subjectId: "u1", actions: "r,u" },
    // c2 不授任何策略 -> 不可见
  ]);

  const svc = await import("../../pat/patService.js");
  rwToken = (await svc.createPat("u1", { name: "rw", scopes: ["canvas:read", "canvas:write"], expiresInDays: 90 })).plaintext;
  roToken = (await svc.createPat("u3", { name: "ro", scopes: ["canvas:read"], expiresInDays: 90 })).plaintext;
  woToken = (await svc.createPat("u2", { name: "wo", scopes: ["canvas:write"], expiresInDays: 90 })).plaintext;
  app = (await import("../../../app.js")).createApp().app as unknown as typeof app;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("S6b scope 粗筛与未注册直调", () => {
  it("canvas:read-only 看不到 commit_elements（tools/list 恰为读工具+ping）", async () => {
    expect(await names(roToken)).toEqual(["canvas.get_board", "ping_echo"]);
  });
  it("canvas:write 只写身份看得到 commit_elements 且恰含 commit+ping（无读工具）", async () => {
    expect(await names(woToken)).toEqual(["canvas.commit_elements", "ping_echo"]);
  });
  it("读写身份 tools/list 含两件 canvas 工具", async () => {
    expect(await names(rwToken)).toEqual(["canvas.commit_elements", "canvas.get_board", "ping_echo"]);
  });
  it("只读 PAT 直调写工具 -> UNKNOWN_TOOL（-32602）", async () => {
    const r = await commit({ docId: c1, ops: [{ op: "element.create", element: rect() }], confirm: true }, roToken);
    expect(r.status).toBe(200);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain("-32602");
  });
});

describe("S6b 三矩形 element.create 成功链路", () => {
  it("尾插 +3、新元素在尾部、服务端生成 id、get_board 往返一致、contentVersion 恰好 +1", async () => {
    const before = await row();
    const r = await commit({
      docId: c1,
      ops: [
        { op: "element.create", element: rect({ gxNote: "甲" }) },
        { op: "element.create", element: rect({ points: [[1, 1], [2, 2]] }) },
        { op: "element.create", element: rect({ customMeta: { k: "v" } }) },
      ],
      baseVersion: before.contentVersion,
      confirm: true,
    });
    expect(r.result.isError ?? false, `commit -> ${r.result.content[0]!.text}`).toBe(false);
    const receipt = JSON.parse(r.result.content[0]!.text) as {
      ok: boolean; contentVersion: number; elementCount: number; appendedIds: string[];
    };
    expect(receipt.contentVersion).toBe(before.contentVersion + 1);
    // 有 canvas r 的回执：带元素总数与服务端新 id（入参无 id，id 与入参无关）
    expect(receipt.elementCount).toBe(4);
    expect(receipt.appendedIds).toHaveLength(3);
    expect(new Set(receipt.appendedIds).size).toBe(3);
    expect(receipt.appendedIds.every((id) => typeof id === "string" && id !== "seed0")).toBe(true);

    const after = await row();
    expect(after.contentVersion).toBe(before.contentVersion + 1);
    const els = JSON.parse(after.content) as Array<Record<string, unknown>>;
    expect(els).toHaveLength(4); // 种子 1 + 新 3
    expect(els[0]!.id).toBe("seed0"); // 既有不动
    const created = els.slice(1);
    // 尾插顺序
    expect((created[0]!.gxNote)).toBe("甲");
    // 服务端生成 id：非空字符串、与入参无关（入参无 id 键）
    expect(created.every((e) => typeof e.id === "string" && (e.id as string).length > 0)).toBe(true);
    expect(new Set(created.map((e) => e.id)).size).toBe(3); // 批内唯一
    expect(created.every((e) => e.id !== "seed0")).toBe(true);
    // 普通未知键透传
    expect(created[2]!.customMeta).toEqual({ k: "v" });

    // 经协议读回往返一致
    const board = await boardElements();
    expect(board.elementCount).toBe(4);
    expect(board.contentVersion).toBe(after.contentVersion);
    expect(board.elements).toEqual(els);
  });
});

describe("S6b confirm / 入参信封", () => {
  it("缺 confirm / confirm=false -> -32602 且未落库", async () => {
    const before = await row();
    for (const args of [
      { docId: c1, ops: [{ op: "element.create", element: rect() }] },
      { docId: c1, ops: [{ op: "element.create", element: rect() }], confirm: false },
    ]) {
      const r = await commit(args);
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0]!.text).toContain("-32602");
    }
    const after = await row();
    expect(after.content).toBe(before.content);
    expect(after.contentVersion).toBe(before.contentVersion);
  });
  it("空 ops / ops>100 -> -32602", async () => {
    const cur = (await row()).contentVersion;
    const empty = await commit({ docId: c1, ops: [], baseVersion: cur, confirm: true });
    expect(empty.result.isError).toBe(true);
    expect(empty.result.content[0]!.text).toContain("-32602");
    const tooMany = await commit({
      docId: c1, baseVersion: cur, confirm: true,
      ops: Array.from({ length: 101 }, () => ({ op: "element.create", element: rect() })),
    });
    expect(tooMany.result.isError).toBe(true);
    expect(tooMany.result.content[0]!.text).toContain("-32602");
  });
});

describe("S6b 六类坏输入：各自 code 且 DB 逐字节未变（原子）", () => {
  const cases: Array<{ name: string; element?: Record<string, unknown>; op?: Record<string, unknown>; code: string; supported?: boolean }> = [
    { name: "自带 id", element: rect({ id: "evil" }), code: "INVALID_PARAMS" },
    { name: "zIndex 键", element: rect({ zIndex: 9 }), code: "INVALID_PARAMS" },
    { name: "非法 shape", element: rect({ shape: "ellipse" }), code: "UNSUPPORTED_OPERATION" },
    { name: "arrow-line", element: { type: "arrow-line", shape: "straight", points: [[0, 0], [1, 1]], source: {}, target: {} }, code: "UNSUPPORTED_OPERATION" },
    { name: "gxLinkRef 关联块", element: rect({ gxLinkRef: { docId: "d", kind: "doc", title: "t" } }), code: "UNSUPPORTED_OPERATION" },
    { name: "gxDocRef 文档引用（二期）", element: rect({ gxDocRef: { docId: "d", kind: "doc", title: "t" } }), code: "UNSUPPORTED_OPERATION" },
    { name: "data-gx-* DOM 键", element: rect({ "data-gx-link-fo": "1" }), code: "INVALID_PARAMS" },
    { name: "gx* 越界键", element: rect({ gxEvil: 1 }), code: "INVALID_PARAMS" },
    { name: "不支持操作名 element.delete", op: { op: "element.delete", element: { id: "x" } }, code: "UNSUPPORTED_OPERATION", supported: true },
  ];
  for (const c of cases) {
    it(`${c.name} -> ${c.code}（原子，未落库）`, async () => {
      const before = await row();
      const op = c.op ?? { op: "element.create", element: c.element };
      const r = await commit({ docId: c1, ops: [op], baseVersion: before.contentVersion, confirm: true });
      expect(r.result.isError, `应失败：${c.name}`).toBe(true);
      const body = JSON.parse(r.result.content[0]!.text) as { code: string; supported?: string[] };
      expect(body.code).toBe(c.code);
      if (c.supported) expect(body.supported).toEqual(["element.create"]);
      const after = await row();
      expect(after.content, `${c.name} 不得半应用`).toBe(before.content);
      expect(after.contentVersion).toBe(before.contentVersion);
    });
  }
});

describe("S6b points / 自定义键 / 上限", () => {
  it("宽高非正（p2.x<=p1.x）-> INVALID_PARAMS 且未落库", async () => {
    const before = await row();
    const r = await commit({
      docId: c1, baseVersion: before.contentVersion, confirm: true,
      ops: [{ op: "element.create", element: rect({ points: [[10, 10], [10, 20]] }) }],
    });
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0]!.text).code).toBe("INVALID_PARAMS");
    const after = await row();
    expect(after.content).toBe(before.content);
  });

  it("未知普通键透传保留；gxEvil 键被拒", async () => {
    const before = await row();
    const ok = await commit({
      docId: c1, baseVersion: before.contentVersion, confirm: true,
      ops: [{ op: "element.create", element: rect({ customMeta: 1 }) }],
    });
    expect(ok.result.isError ?? false, ok.result.content[0]!.text).toBe(false);
    const els = JSON.parse((await row()).content) as Array<Record<string, unknown>>;
    expect(els.some((e) => e.customMeta === 1)).toBe(true);

    const cur = (await row()).contentVersion;
    const bad = await commit({
      docId: c1, baseVersion: cur, confirm: true,
      ops: [{ op: "element.create", element: rect({ gxEvil: 1 }) }],
    });
    expect(bad.result.isError).toBe(true);
    expect(JSON.parse(bad.result.content[0]!.text).code).toBe("INVALID_PARAMS");
  });

  it("批文本超 100KB -> INVALID_PARAMS 不落库", async () => {
    const before = await row();
    // 单 op 携带 210KB 注释（70K 个汉字×3 字节）：批序列化先撞 100KB 上限
    const bigNote = "好".repeat(70 * 1024);
    const r = await commit({
      docId: c1, baseVersion: before.contentVersion, confirm: true,
      ops: [{ op: "element.create", element: rect({ gxNote: bigNote }) }],
    });
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0]!.text).code).toBe("INVALID_PARAMS");
    const after = await row();
    expect(after.content).toBe(before.content);
    expect(after.contentVersion).toBe(before.contentVersion);
  });

  it("既有板逼近 10MB 再追加 -> 整板超 10MB INVALID_PARAMS 不落库", async () => {
    // API 路径单批新增受 100KB 批文本上限约束，无法单批造 10MB；整板上限只在「大板 + 追加」时可达。
    // 专用大画布夹具（确定性 nav id，否则 syncNav 会清理）：既有元素含约 10MB 的普通键负载。
    const bigPayload = "a".repeat(10 * 1024 * 1024 + 1024);
    const bigId = (await prisma.kbDoc.create({
      data: {
        kbId: "kb1", kind: "canvas", title: "大板",
        content: JSON.stringify([{ id: "bigseed", type: "geometry", shape: "rectangle", points: [[0, 0], [1, 1]], customBlob: bigPayload }]),
        createdBy: "owner0", updatedBy: "owner0",
      },
    })).id;
    const nav = nodeId("canvas", bigId);
    await prisma.navNode.create({
      data: { id: nav, workspaceId: "ws_default", parentId: nodeId("kb", "kb1"), kind: "canvas", resourceType: "canvas", resourceId: bigId, name: nav, path: `/${nodeId("kb", "kb1")}/${nav}/`, depth: 2 },
    });
    await prisma.authPolicy.create({
      data: { id: "p_big", workspaceId: "ws_default", nodeId: nav, subjectType: "user", subjectId: "u1", actions: "r,u", createdBy: "seed" },
    });
    const before = await prisma.kbDoc.findUniqueOrThrow({ where: { id: bigId } });
    const r = await commit({ docId: bigId, baseVersion: before.contentVersion, confirm: true, ops: [{ op: "element.create", element: rect() }] });
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0]!.text).code).toBe("INVALID_PARAMS");
    const after = await prisma.kbDoc.findUniqueOrThrow({ where: { id: bigId } });
    expect(after.content).toBe(before.content);
    expect(after.contentVersion).toBe(before.contentVersion);
  }, 30000);
});

describe("S6b 乐观锁与只写身份", () => {
  it("陈旧 baseVersion -> VERSION_CONFLICT + currentVersion，未落库", async () => {
    const cur = await row();
    expect(cur.contentVersion).toBeGreaterThan(0);
    const r = await commit({
      docId: c1, baseVersion: cur.contentVersion - 1, confirm: true,
      ops: [{ op: "element.create", element: rect({ gxNote: "冲突" }) }],
    });
    expect(r.status).toBe(200);
    expect(r.result.isError).toBe(true);
    const body = JSON.parse(r.result.content[0]!.text) as { code: string; currentVersion: number };
    expect(body.code).toBe("VERSION_CONFLICT");
    expect(body.currentVersion).toBe(cur.contentVersion);
    expect((await row()).content).not.toContain("冲突");
  });

  it("只写身份不传 baseVersion -> LWW 成功 +1、回执恰 {ok:true}（不读 contentVersion，只走协议）", async () => {
    const before = await row();
    const r = await commit({
      docId: c1, confirm: true,
      ops: [{ op: "element.create", element: rect({ gxNote: "只写身份" }) }],
    }, woToken);
    expect(r.result.isError ?? false, r.result.content[0]!.text).toBe(false);
    const payload = JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
    expect(payload).toEqual({ ok: true });
    expect(Object.keys(payload)).toEqual(["ok"]);
    const after = await row();
    expect(after.contentVersion).toBe(before.contentVersion + 1);
    expect(after.content).toContain("只写身份");
  });
});

describe("S6b 资源前置", () => {
  it("无权画布 / 传 doc 类 id -> FORBIDDEN_RESOURCE", async () => {
    const cur = (await row()).contentVersion;
    const hidden = await commit({ docId: c2, baseVersion: 0, confirm: true, ops: [{ op: "element.create", element: rect() }] });
    expect(hidden.result.isError).toBe(true);
    expect(JSON.parse(hidden.result.content[0]!.text).code).toBe("FORBIDDEN_RESOURCE");

    const docKind = await commit({ docId: d1, baseVersion: 0, confirm: true, ops: [{ op: "element.create", element: rect() }] });
    expect(docKind.result.isError).toBe(true);
    expect(JSON.parse(docKind.result.content[0]!.text).code).toBe("FORBIDDEN_RESOURCE");
    // 隐藏/类型不符画布未被改动
    expect((await prisma.kbDoc.findUniqueOrThrow({ where: { id: c2 } })).content).toBe("[]");
    expect((await prisma.kbDoc.findUniqueOrThrow({ where: { id: d1 } })).content).toBe("秘密");
    void cur;
  });
});
