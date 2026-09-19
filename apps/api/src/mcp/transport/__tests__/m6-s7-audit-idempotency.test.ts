// M6/S7 验收（骨架仿 m6-s6b-commit-elements.test.ts：真 app + 真迁移 + 真 PAT + 走真 MCP 协议）：
//   审计：写工具成功落 mcp_tool_call 且字段白名单（无 fields/ops 业务值、无 token 明文）；
//         只读 PAT 直调未注册工具 -> UNKNOWN_TOOL 且审计仍记 tool 名与 patId；
//         伪造/吊销/过期 token -> mcp_auth_failure（ip + 明文前缀级，无 token）；吊销后下一请求立即 401；
//         审计写入失败（audit.logl 是目录，EISDIR）-> call 仍成功。
//   幂等：同 requestId 重放返首次结果且只一次写；落库证据（新 PrismaClient 读行 + 篡改 DB 响应后重放返 DB 值）；
//         24h 过期重新执行；键隔离（不同工具/不同 PAT）；未传 requestId 行为不变。
//   超时：慢工具 -> TIMEOUT + isError + HTTP 200 不挂死（本文件注入 3s 短超时；**生产默认 30s 见 config.ts**）。
//
// 超时常量位置：apps/api/src/config.ts 的 `mcpToolTimeoutMs: parseNonNegInt(env.GX_MCP_TOOL_TIMEOUT_MS, 30_000)`
// —— 默认 30_000（SPEC §10 铁律）；env 仅用于测试注入短超时。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { createNavNodes, createPolicies } from "../../../domain/authz/__tests__/engineHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";

const ENV_KEYS = ["DATABASE_URL", "GX_DATA_DIR", "GX_AUDIT_DIR", "JWT_SECRET", "NODE_ENV",
  "GX_RATE_LIMIT", "GX_ENTERPRISE_ORG", "GX_M5_SEARCH", "GX_MCP_TOOL_TIMEOUT_MS"] as const;
const PREV: Record<string, string | undefined> = {};

/** 测试注入的超时（生产默认 30_000，见 config.ts）。取值需显著大于本文件正常调用的耗时。 */
const TEST_TIMEOUT_MS = 3000;

/** 慢夹具的释放开关（用例结束置 true，避免悬挂定时器拖住进程）。 */
let slowReleased = false;

let tmpDir: string;
let auditFile: string;
let prisma: PrismaClient;
let app: { request: (u: string, i?: RequestInit) => Promise<Response> };
let d1 = "";
let rwToken = "";        // doc:read + doc:write（u1 签发：u1 有 r,u）
let roToken = "";        // doc:read only（u1 签发，与 rw 同能力）
let rwPatId = "";
let roPatId = "";
let noWriteToken = "";   // u2 签发：u2 对该文档只有 r -> 写工具不入册
let noWritePatId = "";

const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const call = (body: unknown, tok: string, a = app): Promise<Response> =>
  a.request("/mcp", { method: "POST", headers: { ...H, Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
async function callTool(name: string, args: Record<string, unknown>, tok: string, a = app) {
  const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, tok, a);
  return { status: res.status, result: (await res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result };
}
const payloadOf = (text: string) => JSON.parse(text) as Record<string, unknown>;

/** 读审计 JSONL（同步 append，读到的即已落盘）。 */
function auditRecords(): Array<Record<string, unknown>> {
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}
function auditOf(event: string): Array<Record<string, unknown>> {
  return auditRecords().filter((r) => r.event === event);
}
/** 取审计 detail（类型收敛，供断言）。 */
const detailOf = (r: Record<string, unknown>) => (r.detail ?? {}) as Record<string, unknown>;
const docRow = () => prisma.kbDoc.findUniqueOrThrow({ where: { id: d1 } });
const appendOnce = (requestId: string | undefined, tok = rwToken, a = app) =>
  callTool("doc.append_blocks", { docId: d1, ops: [{ type: "p", text: "幂等块" }], ...(requestId ? { requestId } : {}) }, tok, a);

beforeAll(async () => {
  for (const k of ENV_KEYS) PREV[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-m6-s7-"));
  process.env.DATABASE_URL = `file:${path.join(tmpDir, "s7.db")}`;
  process.env.GX_DATA_DIR = tmpDir;
  process.env.GX_AUDIT_DIR = path.join(tmpDir, ".audit");
  process.env.JWT_SECRET = "m6-s7-audit-secret-at-least-16";
  process.env.NODE_ENV = "test";
  process.env.GX_RATE_LIMIT = "off";
  process.env.GX_MCP_TOOL_TIMEOUT_MS = String(TEST_TIMEOUT_MS);
  delete process.env.GX_ENTERPRISE_ORG;
  delete process.env.GX_M5_SEARCH;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", { cwd: process.cwd(), stdio: "ignore", env: process.env });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  auditFile = path.join(process.env.GX_AUDIT_DIR!, "audit.logl");

  await prisma.user.create({ data: { id: "u1", email: "u1@x.com", displayName: "u1", passwordHash: "x", status: "ACTIVE" } });
  const kb = await prisma.knowledgeBase.create({ data: { id: "kb1", name: "库一", createdBy: "owner0" } });
  d1 = (await prisma.kbDoc.create({ data: { kbId: kb.id, kind: "doc", title: "文档一", content: "# 标题\n\n第一段", createdBy: "owner0", updatedBy: "owner0" } })).id;
  await createNavNodes(prisma, [
    { id: nodeId("kb", "kb1"), kind: "kb", resourceType: "kb", resourceId: "kb1" },
    { id: nodeId("doc", d1), kind: "doc", resourceType: "doc", resourceId: d1, parentId: nodeId("kb", "kb1") },
  ]);
  await createPolicies(prisma, [
    { id: "p_d1", nodeId: nodeId("doc", d1), subjectType: "user", subjectId: "u1", actions: "r,u" },
    // u2：只有 r（无 u）——P3 起「写工具是否入册」按签发者实时计算，需要一个拿不到写工具的主体。
    { id: "p_d1_ro", nodeId: nodeId("doc", d1), subjectType: "user", subjectId: "u2", actions: "r" },
  ]);

  const svc = await import("../../pat/patService.js");
  const rw = await svc.createPat("u1", { name: "rw", scopes: ["doc:read", "doc:write"], expiresInDays: 90 });
  const ro = await svc.createPat("u1", { name: "ro", scopes: ["doc:read"], expiresInDays: 90 });
  rwToken = rw.plaintext; rwPatId = rw.pat.id;
  roToken = ro.plaintext; roPatId = ro.pat.id;
  await prisma.user.create({ data: { id: "u2", email: "u2@x.com", displayName: "u2", passwordHash: "x", status: "ACTIVE" } });
  // noWriteToken：签发者 u2 对该文档无 u -> 写工具不入册（UNKNOWN_TOOL 用例的主体）。
  const nw = await svc.createPat("u2", { name: "nw", scopes: ["doc:read"], expiresInDays: 90 });
  noWriteToken = nw.plaintext; noWritePatId = nw.pat.id;
  app = (await import("../../../app.js")).createApp().app as unknown as typeof app;
}, 120000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/* ------------------------------- A. 调用审计 ------------------------------- */

describe("S7 审计：mcp_tool_call（成功）字段白名单", () => {
  it("写工具成功 -> 落 mcp_tool_call，含 tool/patId/resultCode/resource；无 ops 业务值、无 token 明文", async () => {
    const r = await callTool("doc.append_blocks", { docId: d1, ops: [{ type: "p", text: "探针值_勿泄漏" }] }, rwToken);
    expect(r.result.isError ?? false).toBe(false);

    const lines = auditOf("mcp_tool_call").filter(
      (x) => detailOf(x).tool === "doc.append_blocks" && detailOf(x).resultCode === "OK",
    );
    expect(lines.length, "应至少落一条成功的 mcp_tool_call").toBeGreaterThan(0);
    const rec = lines[lines.length - 1]!;
    const d = detailOf(rec);
    expect(d.tool).toBe("doc.append_blocks");
    expect(d.patId).toBe(rwPatId);
    expect(d.resultCode).toBe("OK");
    expect(d.resource).toEqual({ kind: "doc", id: d1 });
    // 白名单：资源 id 与元信息在，业务值（ops 文本）不在
    const args = d.args as Record<string, unknown>;
    expect(args.docId).toBe(d1);
    expect(Object.prototype.hasOwnProperty.call(args, "ops")).toBe(false);
    expect(JSON.stringify(rec)).not.toContain("探针值_勿泄漏");
    // token 绝不落盘
    expect(fs.readFileSync(auditFile, "utf8")).not.toContain(rwToken);
  });
});

describe("S7 审计：UNKNOWN_TOOL 直调（SDK 直接拒，信封拿不到控制权）", () => {
  // 语义适配（P3）：原用 roToken（u1 签发，u1 有 u）-> 新口径下它能写，不再是 UNKNOWN_TOOL。
  // 换 noWriteToken（签发者 u2 只有 r），"未注册 -> -32602 且审计仍补记" 的不变量原样保留。
  it("签发者无写权限的令牌直调写工具 -> -32602，但审计仍记下 tool 名与 patId", async () => {
    const r = await callTool("doc.append_blocks", { docId: d1, ops: [{ type: "p", text: "x" }] }, noWriteToken);
    expect(r.status).toBe(200);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toContain("-32602");

    const rec = auditOf("mcp_tool_call").filter((x) => detailOf(x).resultCode === "UNKNOWN_TOOL").pop();
    expect(rec, "UNKNOWN_TOOL 必须补记审计").toBeTruthy();
    expect(detailOf(rec!).tool).toBe("doc.append_blocks");
    expect(detailOf(rec!).patId).toBe(noWritePatId);
    expect(rec!.status).toBe(404);
  });
});

describe("S7 审计：mcp_auth_failure", () => {
  it("伪造 token / 已吊销 / 已过期 / 非 PAT 形态 -> 401 且审计记 reason+ip（无完整 token）", async () => {
    const svc = await import("../../pat/patService.js");
    const doomed = await svc.createPat("u1", { name: "doomed", scopes: ["doc:read"], expiresInDays: 90 });
    await svc.revokePat("u1", doomed.pat.id);
    const stale = await svc.createPat("u1", { name: "stale", scopes: ["doc:read"], expiresInDays: 90 });
    await prisma.personalAccessToken.updateMany({
      where: { id: stale.pat.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const cases: Array<[string, string]> = [
      ["unknown_token", "gxpat_thisTokenDoesNotExistAtAll1234567"],
      ["revoked", doomed.plaintext],
      ["expired", stale.plaintext],
      ["not_pat_prefix", "not-a-pat-value"],
    ];
    for (const [reason, tok] of cases) {
      const res = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, tok);
      expect(res.status, `${reason} 应为 401`).toBe(401);
      const rec = auditOf("mcp_auth_failure").filter((x) => detailOf(x).reason === reason).pop();
      expect(rec, `${reason} 应有 mcp_auth_failure 审计`).toBeTruthy();
      expect(rec!.ip).toBeTruthy();
      expect(rec!.status).toBe(401);
      // 无 token 明文；PAT 形态才带 14 字符前缀（非 PAT 形态不截断任意 Authorization 值）
      expect(JSON.stringify(rec)).not.toContain(tok);
      if (tok.startsWith("gxpat_")) {
        expect(String(detailOf(rec!).patPrefix)).toBe(tok.slice(0, 14));
      } else {
        expect(detailOf(rec!).patPrefix).toBeUndefined();
      }
    }
    // 整份审计文件里也不得出现被吊销/过期 token 明文
    const all = fs.readFileSync(auditFile, "utf8");
    expect(all).not.toContain(doomed.plaintext);
    expect(all).not.toContain(stale.plaintext);
  });

  it("AC-M6-4 回归：吊销后下一次调用立即 401（S7 信封未破坏即时失效）", async () => {
    const svc = await import("../../pat/patService.js");
    const live = await svc.createPat("u1", { name: "live", scopes: ["doc:read"], expiresInDays: 90 });
    const ok = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, live.plaintext);
    expect(ok.status).toBe(200);
    await svc.revokePat("u1", live.pat.id);
    const after = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, live.plaintext);
    expect(after.status).toBe(401);
  });
});

/* ------------------------------- B. 幂等 ------------------------------- */

describe("S7 幂等：同 requestId 重放", () => {
  it("重放返首次结果（逐字节相等）且 DB 只发生一次写（contentVersion 只 +1）", async () => {
    const rid = "rid-replay-1";
    const before = await docRow();
    const first = await appendOnce(rid);
    expect(first.result.isError ?? false).toBe(false);
    const mid = await docRow();
    expect(mid.contentVersion).toBe(before.contentVersion + 1);

    const second = await appendOnce(rid);
    expect(second.result.isError ?? false).toBe(false);
    // 返首次结果（responseJson 原样）
    expect(second.result.content[0]!.text).toBe(first.result.content[0]!.text);
    // 只发生一次写
    const after = await docRow();
    expect(after.contentVersion).toBe(mid.contentVersion);
    expect(after.content).toBe(mid.content);
    // 审计标记了幂等重放
    const replay = auditOf("mcp_tool_call").filter((x) => detailOf(x).idempotentReplay === true);
    expect(replay.length).toBeGreaterThan(0);
  });

  it("幂等行落库（新 PrismaClient 可读），且重放结果**取自 DB**（篡改 DB 响应后重放返篡改值）", async () => {
    const rid = "rid-db-source";
    await appendOnce(rid);
    const key = JSON.stringify([rwPatId, "doc.append_blocks", rid]);
    // 新 PrismaClient（独立连接，绕开进程内实例）证明"落库而非内存"
    const fresh = new PrismaClient();
    try {
      const row = await fresh.mcpIdempotency.findUnique({ where: { key } });
      expect(row, "幂等行必须落库").toBeTruthy();
      expect(row!.patId).toBe(rwPatId);
      expect(row!.tool).toBe("doc.append_blocks");
      expect(row!.responseJson.length).toBeGreaterThan(0);
    } finally {
      await fresh.$disconnect();
    }

    // 篡改库里存的"首次结果" -> 重放必须原样吐回该值（证明取自 DB，非重新执行）
    const sentinel = JSON.stringify({ content: [{ type: "text", text: "FROM_DB_SENTINEL" }] });
    await prisma.mcpIdempotency.update({ where: { key }, data: { responseJson: sentinel, createdAt: new Date() } });
    const replay = await appendOnce(rid);
    expect(replay.result.content[0]!.text).toBe("FROM_DB_SENTINEL");
  });

  it("进程重启语义：用**新 app 实例**（同一 DB）重放仍返首次结果，且不再写库", async () => {
    const rid = "rid-restart";
    const first = await appendOnce(rid);
    const mid = await docRow();
    // 模拟重启：重新 createApp（不共享任何进程内请求态）
    const restarted = (await import("../../../app.js")).createApp().app as unknown as typeof app;
    const replay = await appendOnce(rid, rwToken, restarted);
    expect(replay.result.content[0]!.text).toBe(first.result.content[0]!.text);
    expect((await docRow()).contentVersion).toBe(mid.contentVersion);
  });

  it("24h 过期：createdAt 改早 25h 后同 requestId 重新执行（窗失效）", async () => {
    const rid = "rid-expired";
    await appendOnce(rid);
    const key = JSON.stringify([rwPatId, "doc.append_blocks", rid]);
    await prisma.mcpIdempotency.update({
      where: { key },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const mid = await docRow();
    const again = await appendOnce(rid);
    expect(again.result.isError ?? false).toBe(false);
    // 重新执行 -> 版本再次 +1（窗失效）
    expect((await docRow()).contentVersion).toBe(mid.contentVersion + 1);
  });

  it("键隔离：同 requestId 不同工具 / 不同 PAT 各自独立执行", async () => {
    const rid = "rid-isolation";
    const v0 = (await docRow()).contentVersion;
    // 同 PAT 不同工具：append_blocks 与 delete_blocks 各执行一次（delete 用一个不存在 id? 用真实 id）
    const append = await appendOnce(rid);
    expect(append.result.isError ?? false).toBe(false);
    const v1 = (await docRow()).contentVersion;
    expect(v1).toBe(v0 + 1);

    // 不同 PAT、同工具、同 requestId：roToken 看不到写工具 -> 走 UNKNOWN_TOOL，不产生写
    // 故换用"另一个写 PAT"验证隔离：新建第二枚 rw PAT，同 requestId 应独立执行
    const svc = await import("../../pat/patService.js");
    const rw2 = await svc.createPat("u1", { name: "rw2", scopes: ["doc:read", "doc:write"], expiresInDays: 90 });
    const other = await callTool("doc.append_blocks", { docId: d1, ops: [{ type: "p", text: "幂等块" }], requestId: rid }, rw2.plaintext);
    expect(other.result.isError ?? false).toBe(false);
    const v2 = (await docRow()).contentVersion;
    expect(v2, "不同 PAT 同 requestId 必须独立执行（键含 patId）").toBe(v1 + 1);
    // 幂等键行确实按 patId 分开
    expect(await prisma.mcpIdempotency.count({ where: { key: JSON.stringify([rw2.pat.id, "doc.append_blocks", rid]) } })).toBe(1);
    expect(await prisma.mcpIdempotency.count({ where: { key: JSON.stringify([rwPatId, "doc.append_blocks", rid]) } })).toBe(1);
  });

  it("未传 requestId -> 不参与幂等（两次都执行、各 +1，行为与 S6b 一致）", async () => {
    const v0 = (await docRow()).contentVersion;
    const rowsBefore = await prisma.mcpIdempotency.count();
    await appendOnce(undefined);
    await appendOnce(undefined);
    expect((await docRow()).contentVersion).toBe(v0 + 2);
    // 未传 requestId 不产生任何幂等行（不参与幂等，逐字节维持原行为）
    expect(await prisma.mcpIdempotency.count()).toBe(rowsBefore);
  });
});

/* ------------------------------- C. 超时 ------------------------------- */

describe("S7 超时：慢工具返 TIMEOUT 且不挂死连接", () => {
  it("慢夹具 -> TIMEOUT + isError + HTTP 200 + 耗时≈注入超时", async () => {
    // 临时注册一个可中断的慢工具（测试替身仅限 __tests__；用 available() 门保证只在慢用例期间可见）
    const { TOOL_CATALOG } = await import("../../tools/catalog.js");
    const slowSpec = {
      meta: {
        name: "test.slow", title: "slow", description: "慢夹具",
        scopes: [], family: null, readOnly: true,
        available: () => true,
      },
      inputShape: {},
      run: async () => {
        for (let i = 0; i < 200 && !slowReleased; i++) await new Promise((r) => setTimeout(r, 50));
        return { content: [{ type: "text", text: "slow-done" }] };
      },
    };
    (TOOL_CATALOG as unknown as unknown[]).push(slowSpec);
    try {
      const t0 = Date.now();
      const r = await callTool("test.slow", {}, rwToken);
      const elapsed = Date.now() - t0;
      expect(r.status, "HTTP 必须正常返回（不挂死连接）").toBe(200);
      expect(r.result.isError).toBe(true);
      expect(payloadOf(r.result.content[0]!.text).code).toBe("TIMEOUT");
      expect(elapsed).toBeGreaterThanOrEqual(TEST_TIMEOUT_MS - 200);
      expect(elapsed).toBeLessThan(TEST_TIMEOUT_MS + 2500);
      // 超时也入审计
      expect(auditOf("mcp_tool_call").some((x) => detailOf(x).resultCode === "TIMEOUT")).toBe(true);
    } finally {
      slowReleased = true;
      const i = (TOOL_CATALOG as unknown as unknown[]).indexOf(slowSpec);
      if (i >= 0) (TOOL_CATALOG as unknown as unknown[]).splice(i, 1);
    }
  }, 30000);
});

/* --------------------------- D. 审计失败不阻断 --------------------------- */

describe("S7 审计纪律：写入失败不阻断业务", () => {
  it("audit.logl 为目录（EISDIR）时 call 仍成功返回业务结果", async () => {
    const backup = `${auditFile}.bak`;
    fs.renameSync(auditFile, backup);
    fs.mkdirSync(auditFile); // 同名目录 -> appendFileSync EISDIR
    try {
      const r = await appendOnce(undefined);
      expect(r.result.isError ?? false).toBe(false);
      expect(r.result.content[0]!.text.length).toBeGreaterThan(0);
    } finally {
      fs.rmdirSync(auditFile);
      fs.renameSync(backup, auditFile);
    }
  });
});
