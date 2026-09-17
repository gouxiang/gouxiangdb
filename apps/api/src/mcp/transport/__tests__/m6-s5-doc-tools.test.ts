// M6/S5 doc 族 4 工具验收（真 app + 真 M4 夹具 + 真 PAT，与 m6-s4-write-tools 同模式）：
//   get（blocks/markdown/range 安全截断）、append（afterBlockId/服务端生成 id/批文本 100KB）、
//   update（text/align 注释通道）、delete（confirm 原子批）、乐观锁 VERSION_CONFLICT（带 currentVersion）、
//   scope 粗筛 + 只写身份精简回执 + 不可见文档四工具全拒 + 与 REST 同源（同一事务体/searchText 投影）。
//
// 关键口径：正文读写**同一事务体**（domain/kbDocWrite.saveDocContentTx），块/Markdown 唯一真源 @gx/blocks。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { blocksToMd, mdToBlocks } from "@gx/blocks";
import { createNavNodes, createPolicies } from "../../../domain/authz/__tests__/engineHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";

const ENV_KEYS = ["DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV",
  "GX_RATE_LIMIT", "GX_ENTERPRISE_ORG", "GX_M5_SEARCH"] as const;
const PREV: Record<string, string | undefined> = {};

// buildSearchText 定义在 domain/kb.ts（顶层 import 会连带加载 db.js 单例，绑定到迁移前的空库）；
// 故**惰性动态导入**，在 beforeAll 设好 DATABASE_URL 之后再取（与 app 动态导入同因）。
let buildSearchText: (kind: string, content: string) => string;

const SAMPLE_MD = ["# 标题", "", "第一段", "", "- 甲", "- 乙", "", "- [ ] 待办"].join("\n");

let tmpDir: string;
let prisma: PrismaClient;
let app: { request: (u: string, i?: RequestInit) => Promise<Response> };
let d1 = ""; // 可见文档
let d2 = ""; // 不可见文档（无策略）
let rwToken = ""; // doc:read + doc:write（M4: 对 d1 授 r,u）
let roToken = ""; // 仅 doc:read（u3，对 d1 授 r）
let woToken = ""; // 仅 doc:write（u2，对 d1 只授 u，无 r）——只写身份

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
/** 读 d1 当前块的便捷封装。 */
async function getBlocks(tok = rwToken) {
  const r = await callTool("doc.get_doc_blocks", { docId: d1, format: "blocks" }, tok);
  return JSON.parse(r.result.content[0]!.text) as { contentVersion: number; total: number; truncated: boolean; blocks: Array<Record<string, unknown>> };
}
const docRow = () => prisma.kbDoc.findUniqueOrThrow({ where: { id: d1 } });

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s5-doc-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s5doc.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = "m6-s5-doc-secret-at-least-16-chars";
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
  // creator 一律置 owner0（避免 creator 兜底 UNION 干扰"策略驱动"断言）
  const kb = await prisma.knowledgeBase.create({ data: { id: "kb1", name: "库一", createdBy: "owner0" } });
  d1 = (await prisma.kbDoc.create({ data: { kbId: kb.id, kind: "doc", title: "文档一", content: SAMPLE_MD, createdBy: "owner0", updatedBy: "owner0" } })).id;
  d2 = (await prisma.kbDoc.create({ data: { kbId: kb.id, kind: "doc", title: "文档二", content: "秘密", createdBy: "owner0", updatedBy: "owner0" } })).id;

  // nav 节点用**确定性 id**（nodeId）：写操作经 syncNavFromEntitiesTx 对齐，非确定 id 会被清理并连带删策略
  await createNavNodes(prisma, [
    { id: nodeId("kb", "kb1"), kind: "kb", resourceType: "kb", resourceId: "kb1" },
    { id: nodeId("doc", d1), kind: "doc", resourceType: "doc", resourceId: d1, parentId: nodeId("kb", "kb1") },
  ]);
  await createPolicies(prisma, [
    // 注意：**不在 kb 节点授 r**——kb 级 r 会经 inheritAncestors 祖先并集下传到其下所有 doc
    // （d2 将因此对 u1 可见，破坏"不可见文档"夹具）。族可见集由 doc 节点自身策略满足。
    { id: "p_d1", nodeId: nodeId("doc", d1), subjectType: "user", subjectId: "u1", actions: "r,u" },
    { id: "p_d1_ro", nodeId: nodeId("doc", d1), subjectType: "user", subjectId: "u3", actions: "r" },
    { id: "p_d1_wo", nodeId: nodeId("doc", d1), subjectType: "user", subjectId: "u2", actions: "u" },
  ]);

  const svc = await import("../../pat/patService.js");
  rwToken = (await svc.createPat("u1", { name: "rw", scopes: ["doc:read", "doc:write"], expiresInDays: 90 })).plaintext;
  roToken = (await svc.createPat("u3", { name: "ro", scopes: ["doc:read"], expiresInDays: 90 })).plaintext;
  woToken = (await svc.createPat("u2", { name: "wo", scopes: ["doc:write"], expiresInDays: 90 })).plaintext;
  app = (await import("../../../app.js")).createApp().app as unknown as typeof app;
  buildSearchText = (await import("../../../domain/kb.js")).buildSearchText;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("S5 doc 族注册与 scope 粗筛", () => {
  it("读写 PAT：tools/list 恰含 4 个 doc 工具；无权限族工具不越界", async () => {
    expect(await names(rwToken)).toEqual([
      "doc.append_blocks", "doc.delete_blocks", "doc.get_doc_blocks", "doc.update_block", "ping_echo",
    ]);
  });

  it("只读 PAT：仅 get_doc_blocks（写工具不入册）", async () => {
    expect(await names(roToken)).toEqual(["doc.get_doc_blocks", "ping_echo"]);
  });

  it("action 敏感闸门一：只写身份 tools/list 恰为写工具（无 get_doc_blocks）", async () => {
    expect(await names(woToken)).toEqual(["doc.append_blocks", "doc.delete_blocks", "doc.update_block", "ping_echo"]);
  });

  it("只读 PAT 直调写工具 -> UNKNOWN_TOOL（未注册，不泄漏存在性）", async () => {
    const r = await callTool("doc.append_blocks", { docId: d1, ops: [{ type: "p", text: "x" }], baseVersion: 0 }, roToken);
    expect(r.status).toBe(200);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain("-32602");
  });
});

describe("S5 doc.get_doc_blocks", () => {
  it("format=markdown -> 原始正文直出（与库内一致）", async () => {
    const cur = await docRow();
    const r = await callTool("doc.get_doc_blocks", { docId: d1, format: "markdown" }, rwToken);
    expect(r.result.isError ?? false).toBe(false);
    const p = JSON.parse(r.result.content[0]!.text) as { markdown: string; contentVersion: number };
    expect(p.markdown).toBe(cur.content);
    expect(p.contentVersion).toBe(cur.contentVersion);
  });

  it("format=blocks -> 结构化块（含 seq/id/type；共 5 块）", async () => {
    const p = await getBlocks();
    expect(p.total).toBe(5);
    expect(p.blocks.map((b) => b.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(p.blocks[0]!.type).toBe("h1");
    expect(p.blocks[1]!.type).toBe("p");
    expect(p.blocks[4]!.type).toBe("task");
    expect(p.blocks.every((b) => typeof b.id === "string" && (b.id as string).length > 0)).toBe(true);
  });

  it("range 按块 seq 0-based 闭区间切片；越界安全截断（不抛错）", async () => {
    const mid = await callTool("doc.get_doc_blocks", { docId: d1, format: "blocks", range: { start: 1, end: 2 } }, rwToken);
    const mp = JSON.parse(mid.result.content[0]!.text) as { blocks: Array<{ seq: number }>; truncated: boolean };
    expect(mp.blocks.map((b) => b.seq)).toEqual([1, 2]);
    expect(mp.truncated).toBe(false);

    const oob = await callTool("doc.get_doc_blocks", { docId: d1, format: "blocks", range: { start: 3, end: 99 } }, rwToken);
    const op = JSON.parse(oob.result.content[0]!.text) as { blocks: Array<{ seq: number }>; truncated: boolean };
    expect(op.blocks.map((b) => b.seq)).toEqual([3, 4]);
    expect(op.truncated).toBe(true);
  });
});

describe("S5 doc.append_blocks", () => {
  it("乐观锁成功：单事务一次 version+1；与 REST 同源（content/searchText 投影一致）；回执带 contentVersion", async () => {
    const before = await docRow();
    const r = await callTool("doc.append_blocks", { docId: d1, ops: [{ type: "p", text: "附录一" }], baseVersion: before.contentVersion }, rwToken);
    expect(r.result.isError ?? false).toBe(false);
    const receipt = JSON.parse(r.result.content[0]!.text) as { ok: boolean; contentVersion: number };
    expect(receipt.ok).toBe(true);
    expect(receipt.contentVersion).toBe(before.contentVersion + 1);

    const after = await docRow();
    expect(after.contentVersion).toBe(before.contentVersion + 1);
    expect(after.content).toContain("附录一");
    // 与 REST PUT 同一事务体：searchText 为 buildSearchText(kind, content)（同一投影）
    expect(after.searchText).toBe(buildSearchText(after.kind, after.content));
    // 自动版本快照同事务落地（REST 语义）
    expect(await prisma.kbDocVersion.count({ where: { docId: d1 } })).toBeGreaterThanOrEqual(1);
  });

  it("afterBlockId -> 在该块之后插入（顺序正确）", async () => {
    const p = await getBlocks();
    const firstId = String(p.blocks[0]!.id);
    const r = await callTool("doc.append_blocks", { docId: d1, afterBlockId: firstId, ops: [{ type: "p", text: "插入项" }], baseVersion: p.contentVersion }, rwToken);
    expect(r.result.isError ?? false).toBe(false);
    const after = await getBlocks();
    // 新块紧跟第 0 块（seq=1），原第 1 块顺延
    expect(after.blocks[1]!.text).toBe("插入项");
  });

  it("afterBlockId 不存在 -> INVALID_PARAMS", async () => {
    const p = await getBlocks();
    const r = await callTool("doc.append_blocks", { docId: d1, afterBlockId: "no_such_block", ops: [{ type: "p", text: "x" }], baseVersion: p.contentVersion }, rwToken);
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0]!.text).code).toBe("INVALID_PARAMS");
  });

  it("AI 不得自带 id：op 内 id 被忽略，服务端生成新 id", async () => {
    const p = await getBlocks();
    const r = await callTool("doc.append_blocks", { docId: d1, ops: [{ type: "p", text: "带毒 id", id: "evil_block_id" }], baseVersion: p.contentVersion }, rwToken);
    expect(r.result.isError ?? false).toBe(false);
    const after = await getBlocks();
    expect(after.blocks.some((b) => b.id === "evil_block_id")).toBe(false);
    expect(after.blocks.every((b) => String(b.id).startsWith("b"))).toBe(true);
  });

  it("ops > 100 -> -32602（zod4 入参校验）", async () => {
    const p = await getBlocks();
    const ops = Array.from({ length: 101 }, () => ({ type: "p", text: "y" }));
    const r = await callTool("doc.append_blocks", { docId: d1, ops, baseVersion: p.contentVersion }, rwToken);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain("-32602");
  });

  it("批文本 > 100KB -> INVALID_PARAMS（服务端 UTF-8 字节实测，非 zod 字符数）", async () => {
    const p = await getBlocks();
    const big = "a".repeat(100 * 1024 + 1);
    const r = await callTool("doc.append_blocks", { docId: d1, ops: [{ type: "p", text: big }], baseVersion: p.contentVersion }, rwToken);
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0]!.text).code).toBe("INVALID_PARAMS");
  });

  it("陈旧 baseVersion -> VERSION_CONFLICT + currentVersion（HTTP 200，协议错误不走 4xx）", async () => {
    const cur = await docRow();
    expect(cur.contentVersion).toBeGreaterThan(0);
    const r = await callTool("doc.append_blocks", { docId: d1, ops: [{ type: "p", text: "冲突写" }], baseVersion: cur.contentVersion - 1 }, rwToken);
    expect(r.status).toBe(200);
    expect(r.result.isError).toBe(true);
    const body = JSON.parse(r.result.content[0]!.text) as { code: string; currentVersion: number };
    expect(body.code).toBe("VERSION_CONFLICT");
    expect(body.currentVersion).toBe(cur.contentVersion);
    // 冲突未落库
    expect((await docRow()).content).not.toContain("冲突写");
  });
});

describe("S5 doc.update_block", () => {
  it("更新 text：库内改动且与 REST 同投影", async () => {
    const p = await getBlocks();
    const target = String(p.blocks[1]!.id);
    const r = await callTool("doc.update_block", { docId: d1, blockId: target, patch: { text: "改写后" }, baseVersion: p.contentVersion }, rwToken);
    expect(r.result.isError ?? false).toBe(false);
    const after = await getBlocks();
    expect(after.blocks[1]!.id).toBe(target);
    expect(after.blocks[1]!.text).toBe("改写后");
    expect((await docRow()).searchText).toBe(buildSearchText("doc", (await docRow()).content));
  });

  it("align 仅走注释通道：写 Block.align -> 序列化为 <!-- align:center -->（不手写 md）", async () => {
    const p = await getBlocks();
    const paraId = String(p.blocks.find((b) => b.type === "p")!.id);
    const r = await callTool("doc.update_block", { docId: d1, blockId: paraId, patch: { align: "center" }, baseVersion: p.contentVersion }, rwToken);
    expect(r.result.isError ?? false).toBe(false);
    const stored = (await docRow()).content;
    // 注释标记紧邻该段正文之前
    const paraText = String((await getBlocks()).blocks.find((b) => b.id === paraId)!.text);
    expect(stored).toContain(`<!-- align:center -->\n${paraText}`);
    // 读回块带 align（注释通道还原）
    expect((await getBlocks()).blocks.find((b) => b.id === paraId)!.align).toBe("center");
  });

  it("blockId 不存在 -> INVALID_PARAMS；align 非法值 -> -32602", async () => {
    const p = await getBlocks();
    const missing = await callTool("doc.update_block", { docId: d1, blockId: "no_such_block", patch: { text: "x" }, baseVersion: p.contentVersion }, rwToken);
    expect(missing.result.isError).toBe(true);
    expect(JSON.parse(missing.result.content[0]!.text).code).toBe("INVALID_PARAMS");

    const bad = await callTool("doc.update_block", { docId: d1, blockId: String(p.blocks[0]!.id), patch: { align: "justify" }, baseVersion: p.contentVersion }, rwToken);
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]!.text).toContain("-32602");
  });
});

describe("S5 doc.delete_blocks", () => {
  it("无 confirm / confirm=false -> -32602（zod4 literal）；目标块未删", async () => {
    const p = await getBlocks();
    const id = String(p.blocks[0]!.id);
    for (const args of [
      { docId: d1, blockIds: [id], baseVersion: p.contentVersion },
      { docId: d1, blockIds: [id], baseVersion: p.contentVersion, confirm: false },
    ]) {
      const r = await callTool("doc.delete_blocks", args, rwToken);
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0]!.text).toContain("-32602");
    }
    expect((await getBlocks()).blocks.some((b) => b.id === id)).toBe(true);
  });

  it("confirm=true -> 原子批删成功（总数 -1；被删块内容消失）", async () => {
    const p = await getBlocks();
    const first = p.blocks[0]!;
    const r = await callTool("doc.delete_blocks", { docId: d1, blockIds: [String(first.id)], baseVersion: p.contentVersion, confirm: true }, rwToken);
    expect(r.result.isError ?? false, `delete -> ${r.result.content[0]!.text}`).toBe(false);
    const after = await getBlocks();
    expect(after.total).toBe(p.total - 1);
    // 位置标识删除后重排（b<seq>）：按**内容**断言被删块确已消失
    expect(after.blocks.some((b) => b.type === first.type && b.text === first.text)).toBe(false);
  });

  it("任一 blockId 不存在 -> 整批失败（原子，无半应用）", async () => {
    const before = await docRow();
    const p = await getBlocks();
    const r = await callTool("doc.delete_blocks", { docId: d1, blockIds: [String(p.blocks[0]!.id), "no_such_block"], baseVersion: p.contentVersion, confirm: true }, rwToken);
    expect(r.result.isError).toBe(true);
    expect(JSON.parse(r.result.content[0]!.text).code).toBe("INVALID_PARAMS");
    const after = await docRow();
    expect(after.contentVersion).toBe(before.contentVersion);
    expect(after.content).toBe(before.content);
  });
});

describe("S5 只写身份：精简回执 + 不可见文档四工具全拒", () => {
  it("只写身份 append 成功且回执为**精简 {ok:true}**（无 contentVersion）", async () => {
    const cur = await docRow();
    const r = await callTool("doc.append_blocks", { docId: d1, ops: [{ type: "p", text: "只写身份写入" }], baseVersion: cur.contentVersion }, woToken);
    expect(r.result.isError ?? false).toBe(false);
    const payload = JSON.parse(r.result.content[0]!.text) as Record<string, unknown>;
    expect(payload).toEqual({ ok: true });
    expect(Object.keys(payload)).toEqual(["ok"]);
    expect((await docRow()).content).toContain("只写身份写入");
  });

  it("不可见 docId -> 四工具全拒 FORBIDDEN_RESOURCE（不泄漏存在性）", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["doc.get_doc_blocks", { docId: d2, format: "blocks" }],
      ["doc.append_blocks", { docId: d2, ops: [{ type: "p", text: "x" }], baseVersion: 0 }],
      ["doc.update_block", { docId: d2, blockId: "b1", patch: { text: "x" }, baseVersion: 0 }],
      ["doc.delete_blocks", { docId: d2, blockIds: ["b1"], baseVersion: 0, confirm: true }],
    ];
    for (const [name, args] of calls) {
      const r = await callTool(name, args, rwToken);
      const text = r.result?.content?.[0]?.text ?? "";
      expect(r.result.isError, `${name} -> ${text}`).toBe(true);
      expect(JSON.parse(text).code, `${name}`).toBe("FORBIDDEN_RESOURCE");
    }
    // 不可见文档未被改动
    expect((await prisma.kbDoc.findUniqueOrThrow({ where: { id: d2 } })).content).toBe("秘密");
  });
});

describe("S5 结构完整性（Web 端可打开）", () => {
  it("MCP 写入后正文经 mdToBlocks/blocksToMd 往返稳定（序列化幂等，无 md 漂移）", async () => {
    const stored = (await docRow()).content;
    expect(blocksToMd(mdToBlocks(stored))).toBe(stored);
    // 写出中不得残留任何 align 之外的注释/异常标记行
    expect(mdToBlocks(stored).length).toBeGreaterThan(0);
  });
});
