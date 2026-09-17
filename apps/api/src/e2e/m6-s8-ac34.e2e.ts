// M6/S8-C3/C4 对抗：AC-M6-3（doc 409/confirm + 画布 UNSUPPORTED_OPERATION 不静默）、
// AC-M6-4（吊销即时 401 + 每次 call 入审计，含被拒/未知工具）。HTTP 与 stdio 两入口各跑。
//
// AC-M6-3 的"Web 端打开结构完整"**不在本文件重造**（派工单已核实覆盖）：
//   - 画布方向：apps/web/e2e/canvas-mcp-golden.spec.ts（S6b 第三步 Playwright，chromium + webkit 双绿）；
//   - doc 块方向：S5 round-trip golden（apps/api/src/mcp/transport/__tests__/m6-s5-doc-tools.test.ts）。
// 本文件只出**服务端侧**证据（写入后经协议读回结构一致）+ 拒绝码矩阵，并在 baseline 引用上述两处。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapE2e, type E2eStack } from "./bootstrap.js";
import { rpc, INIT_MESSAGE, callTool, parseText } from "./serverHarness.js";
import { openStdioClient, readAudit, auditOf, runStdioToExit, type SdkConnection } from "./clientHarness.js";
import { dumpAttackMatrix, recordAttack } from "./attackLog.js";
import type { PatScope } from "../mcp/pat/tokens.js";

const ALL_SCOPES: PatScope[] = ["record:read", "record:write", "doc:read", "doc:write", "canvas:read", "canvas:write"];
/** M6 未开放的画布操作集（C-2 二期边界）：入参出现即整批拒绝，**绝不静默成功**。 */
const UNSUPPORTED_CANVAS_OPS = [
  { label: "element.update", op: { op: "element.update", element: { id: "x" } } },
  { label: "element.move", op: { op: "element.move", element: { id: "x" } } },
  { label: "element.delete", op: { op: "element.delete", element: { id: "x" } } },
  { label: "element.connect", op: { op: "element.connect", element: { id: "x" } } },
  { label: "箭头 arrow-line", op: { op: "element.create", element: { type: "arrow-line", shape: "straight", points: [[0, 0], [1, 1]], source: {}, target: {} } } },
  { label: "gxLinkRef 关联块", op: { op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[0, 0], [1, 1]], gxLinkRef: {} } } },
  { label: "gxDocRef 文档引用", op: { op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[0, 0], [1, 1]], gxDocRef: {} } } },
];

let stack: E2eStack;
let stdio: SdkConnection;
/** 专供吊销对抗的两枚一次性令牌（各自独立，避免用例间隐式顺序依赖）。 */
const victimHttp = { id: "", token: "" };
const victimStdio = { id: "", token: "" };

async function newPat(userId: string, name: string): Promise<{ id: string; token: string }> {
  const svc = await import("../mcp/pat/patService.js");
  const r = await svc.createPat(userId, { name, scopes: ALL_SCOPES, expiresInDays: 90 });
  return { id: r.pat.id, token: r.plaintext };
}

beforeAll(async () => {
  stack = await bootstrapE2e("gx-m6-s8-ac34-");
  Object.assign(victimHttp, await newPat("uFull", "victim-http"));
  Object.assign(victimStdio, await newPat("uFull", "victim-stdio"));
  stdio = await openStdioClient(stack.fx.pat.full.token);
}, 240_000);

afterAll(async () => {
  dumpAttackMatrix();
  await stdio?.close();
  await stack?.close();
});

describe("S8-C3 AC-M6-3a doc 写入：confirm 强制 + 409/currentVersion + 往返一致", () => {
  it("append_blocks 成功一次 contentVersion 恰好 +1，且经协议读回结构一致", async () => {
    const before = parseText<{ contentVersion: number }>(
      await callTool(stack.tcp.target, stack.fx.pat.full.token, "doc.get_doc_blocks", { docId: stack.fx.ids.docId, format: "markdown" }),
    );
    const appended = await callTool(stack.tcp.target, stack.fx.pat.full.token, "doc.append_blocks", {
      docId: stack.fx.ids.docId, ops: [{ type: "p", text: "AI 追加段" }], baseVersion: before.contentVersion,
    });
    expect(appended.isError ?? false, appended.text).toBe(false);
    const after = parseText<{ contentVersion: number; blocks: Array<{ text: string }> }>(
      await callTool(stack.tcp.target, stack.fx.pat.full.token, "doc.get_doc_blocks", { docId: stack.fx.ids.docId, format: "blocks" }),
    );
    expect(after.contentVersion).toBe(before.contentVersion + 1);
    expect(after.blocks.some((b) => (b.text ?? "").includes("AI 追加段"))).toBe(true);
  });

  it("陈旧 baseVersion -> VERSION_CONFLICT + currentVersion（乐观锁未被削弱）", async () => {
    const cur = parseText<{ contentVersion: number }>(
      await callTool(stack.tcp.target, stack.fx.pat.full.token, "doc.get_doc_blocks", { docId: stack.fx.ids.docId, format: "markdown" }),
    ).contentVersion;
    const env = await callTool(stack.tcp.target, stack.fx.pat.full.token, "doc.append_blocks", {
      docId: stack.fx.ids.docId, ops: [{ type: "p", text: "冲突写入" }], baseVersion: cur - 1,
    });
    expect(env.isError).toBe(true);
    const body = parseText<{ code: string; currentVersion: number }>(env);
    expect(body.code).toBe("VERSION_CONFLICT");
    expect(body.currentVersion).toBe(cur);
    recordAttack({ id: "AC-M6-3", entry: "http", input: `append_blocks baseVersion=${cur - 1}（陈旧）`, expected: "VERSION_CONFLICT + currentVersion", actual: `VERSION_CONFLICT currentVersion=${body.currentVersion}`, verdict: "PASS" });
  });

  it("破坏性写缺 confirm 一律拒绝（doc.delete_blocks 与 canvas.commit_elements 各一发）", async () => {
    const del = await callTool(stack.tcp.target, stack.fx.pat.full.token, "doc.delete_blocks", { docId: stack.fx.ids.docId, blockIds: ["b1"] });
    expect(del.isError).toBe(true);
    expect(del.text).toContain("-32602");
    const cv = await callTool(stack.tcp.target, stack.fx.pat.full.token, "canvas.commit_elements", {
      docId: stack.fx.ids.canvasId, ops: [{ op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[0, 0], [1, 1]] } }],
    });
    expect(cv.isError).toBe(true);
    expect(cv.text).toContain("-32602");
    recordAttack({ id: "AC-M6-3", entry: "http", input: "delete_blocks / commit_elements 缺 confirm:true", expected: "-32602（拒绝）", actual: "isError + -32602", verdict: "PASS" });
  });
});

describe("S8-C3 AC-M6-3b 画布二期操作：UNSUPPORTED_OPERATION 显式拒绝、绝不静默", () => {
  it.each(UNSUPPORTED_CANVAS_OPS)("HTTP $label -> UNSUPPORTED_OPERATION + supported=[element.create]", async ({ label, op }) => {
    const env = await callTool(stack.tcp.target, stack.fx.pat.full.token, "canvas.commit_elements", {
      docId: stack.fx.ids.canvasId, ops: [op], confirm: true,
    });
    expect(env.isError, `${label} 必须被拒（不得静默成功）`).toBe(true);
    const body = parseText<{ code: string; supported: string[] }>(env);
    expect(body.code, label).toBe("UNSUPPORTED_OPERATION");
    expect(body.supported, label).toEqual(["element.create"]);
    recordAttack({ id: `AC-M6-3/${label}`, entry: "http", input: `commit_elements ops=[${label}]`, expected: "UNSUPPORTED_OPERATION + supported=[element.create]", actual: "UNSUPPORTED_OPERATION", verdict: "PASS" });
  });

  it("被拒的整批未落库（DB 内容与版本逐字节不变）", async () => {
    const before = await stack.prisma.kbDoc.findUniqueOrThrow({ where: { id: stack.fx.ids.canvasId } });
    const env = await callTool(stack.tcp.target, stack.fx.pat.full.token, "canvas.commit_elements", {
      docId: stack.fx.ids.canvasId, ops: [{ op: "element.update", element: { id: "x" } }], confirm: true,
    });
    expect(env.isError).toBe(true);
    const after = await stack.prisma.kbDoc.findUniqueOrThrow({ where: { id: stack.fx.ids.canvasId } });
    expect(after.content).toBe(before.content);
    expect(after.contentVersion).toBe(before.contentVersion);
  });

  it("stdio 同款一发：element.update -> UNSUPPORTED_OPERATION", async () => {
    const r = await stdio.client.callTool({
      name: "canvas.commit_elements",
      arguments: { docId: stack.fx.ids.canvasId, ops: [{ op: "element.update", element: { id: "x" } }], confirm: true },
    });
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content as Array<{ text?: string }>)[0]?.text ?? "{}") as { code: string; supported: string[] };
    expect(body.code).toBe("UNSUPPORTED_OPERATION");
    expect(body.supported).toEqual(["element.create"]);
    recordAttack({ id: "AC-M6-3/element.update", entry: "stdio", input: "commit_elements ops=[element.update]", expected: "UNSUPPORTED_OPERATION", actual: "UNSUPPORTED_OPERATION", verdict: "PASS" });
  });

  it("stdio doc 写入一发：append_blocks 成功（LWW），证明 stdio 与 HTTP 同构可写", async () => {
    const r = await stdio.client.callTool({
      name: "doc.append_blocks",
      arguments: { docId: stack.fx.ids.docId, ops: [{ type: "p", text: "stdio 追加段" }] },
    });
    expect(r.isError ?? false, (r.content as Array<{ text?: string }>)[0]?.text).toBe(false);
    const payload = JSON.parse((r.content as Array<{ text?: string }>)[0]?.text ?? "{}") as { ok?: boolean };
    expect(payload.ok).toBe(true);
    recordAttack({ id: "AC-M6-3/doc-write", entry: "stdio", input: "append_blocks（LWW）", expected: "ok:true 成功写入", actual: "ok:true", verdict: "PASS" });
  });
});

describe("S8-C4 AC-M6-4 吊销语义与全量审计", () => {
  it("HTTP：先成功建连调用，吊销后**下一请求立即 401**，并落 mcp_auth_failure(revoked)", async () => {
    const okInit = await rpc(stack.tcp.target, INIT_MESSAGE, { token: victimHttp.token });
    expect(okInit.status).toBe(200);
    const okCall = await callTool(stack.tcp.target, victimHttp.token, "ping_echo", { text: "before-revoke" });
    expect(okCall.text).toBe("pong:before-revoke");

    const svc = await import("../mcp/pat/patService.js");
    expect(await svc.revokePat("uFull", victimHttp.id)).toBe(true);

    // 无状态直桥没有"会话缓存"可挂：下一请求即拒（AC-M6-4 的"下一次调用立即拒绝"）。
    const denied = await rpc(stack.tcp.target, INIT_MESSAGE, { token: victimHttp.token });
    expect(denied.status).toBe(401);
    const rows = auditOf(readAudit(stack.env.auditDir), "mcp_auth_failure");
    expect(rows.some((r) => r.detail?.reason === "revoked")).toBe(true);
    recordAttack({ id: "AC-M6-4", entry: "http", input: "吊销后下一请求 initialize", expected: "HTTP 401 + mcp_auth_failure(revoked)", actual: "401 + 审计 reason=revoked", verdict: "PASS" });
  });

  it("stdio：stdio 无连接概念 —— 吊销后**下次启动进程即拒**（退出码 2）", async () => {
    const ok = await openStdioClient(victimStdio.token);
    await ok.close();
    const svc = await import("../mcp/pat/patService.js");
    expect(await svc.revokePat("uFull", victimStdio.id)).toBe(true);

    const after = await runStdioToExit(victimStdio.token);
    expect(after.code).toBe(2);
    expect(after.stderr).toContain("invalid");
    expect(after.stdout).toBe(""); // 协议流零污染
    recordAttack({ id: "AC-M6-4", entry: "stdio", input: "吊销后重启 stdio 进程", expected: "退出码 2", actual: "退出码 2 + stdout 空", verdict: "PASS" });
  });

  it("每次 call 都有审计（成功 / 被拒 / UNKNOWN_TOOL 三类都在），且参数脱敏、无业务值、无 token 明文", async () => {
    // 显式补齐第三类：直调未注册工具（UNKNOWN_TOOL 由 transport 层补记，不经信封）
    const unknown = await callTool(stack.tcp.target, stack.fx.pat.full.token, "no.such_tool", {});
    expect(unknown.isError).toBe(true);
    const calls = auditOf(readAudit(stack.env.auditDir), "mcp_tool_call");
    const codes = new Set(calls.map((c) => c.detail?.resultCode));
    expect(codes.has("OK")).toBe(true);
    expect(codes.has("UNSUPPORTED_OPERATION")).toBe(true);
    expect(codes.has("UNKNOWN_TOOL")).toBe(true);

    // 参数脱敏：任一 detail.args 不出现画布 ops 载荷；审计文件不含 "AI 追加段" 等业务值
    for (const c of calls) expect(JSON.stringify(c.detail?.args ?? {})).not.toContain("element.update");
    const raw = JSON.stringify(calls);
    expect(raw).not.toContain("AI 追加段");
    // token 零泄漏：整份审计不得出现任一 PAT 明文
    const auditText = JSON.stringify(readAudit(stack.env.auditDir));
    for (const tok of [stack.fx.pat.full.token, victimHttp.token, victimStdio.token]) {
      expect(auditText).not.toContain(tok);
      expect(auditText).not.toContain(tok.slice(6)); // 连随机段也不得出现
    }
    // stdio 来源可辨识（ip=stdio），与 HTTP 的 ip 区分
    const events = readAudit(stack.env.auditDir);
    expect(events.some((e) => e.ip === "stdio")).toBe(true);
    expect(events.some((e) => e.path === "/mcp")).toBe(true);
  });
});
