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
/**
 * 当前仍未开放的画布能力（二期边界）：入参出现即整批 UNSUPPORTED_OPERATION，**绝不静默成功**。
 * 注意：element.update/move/delete/connect 已在画布二期落地（见 canvasWrite.tools.ts SUPPORTED），
 * 不再属于本集合；其成功往返在下方 AC-M6-3c 用真实写入证明。
 */
const FUTURE_CANVAS_OPS = [
  { label: "箭头 arrow-line", op: { op: "element.create", element: { type: "arrow-line", shape: "straight", points: [[0, 0], [1, 1]], source: {}, target: {} } } },
  { label: "gxLinkRef 关联块", op: { op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[0, 0], [1, 1]], gxLinkRef: {} } } },
  { label: "gxDocRef 文档引用", op: { op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[0, 0], [1, 1]], gxDocRef: {} } } },
];
/** 画布写入当前支持的操作集（与 canvasWrite.tools.ts SUPPORTED 同序）。 */
const EXPECTED_SUPPORTED = [
  "element.create",
  "element.update",
  "element.move",
  "element.delete",
  "element.connect",
];
function rect(): { type: "geometry"; shape: "rectangle"; points: [[number, number], [number, number]] } {
  return { type: "geometry", shape: "rectangle", points: [[0, 0], [100, 100]] };
}

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

describe("S8-C3 AC-M6-3b 画布二期未开放能力：UNSUPPORTED_OPERATION 显式拒绝、绝不静默", () => {
  it.each(FUTURE_CANVAS_OPS)("HTTP $label -> UNSUPPORTED_OPERATION + supported 含 element.connect", async ({ label, op }) => {
    const env = await callTool(stack.tcp.target, stack.fx.pat.full.token, "canvas.commit_elements", {
      docId: stack.fx.ids.canvasId, ops: [op], confirm: true,
    });
    expect(env.isError, `${label} 必须被拒（不得静默成功）`).toBe(true);
    const body = parseText<{ code: string; supported: string[] }>(env);
    expect(body.code, label).toBe("UNSUPPORTED_OPERATION");
    expect(body.supported, label).toEqual(EXPECTED_SUPPORTED);
    recordAttack({ id: `AC-M6-3/${label}`, entry: "http", input: `commit_elements ops=[${label}]`, expected: "UNSUPPORTED_OPERATION + supported", actual: "UNSUPPORTED_OPERATION", verdict: "PASS" });
  });

  it("被拒的整批未落库（DB 内容与版本逐字节不变）", async () => {
    const before = await stack.prisma.kbDoc.findUniqueOrThrow({ where: { id: stack.fx.ids.canvasId } });
    const env = await callTool(stack.tcp.target, stack.fx.pat.full.token, "canvas.commit_elements", {
      docId: stack.fx.ids.canvasId, ops: FUTURE_CANVAS_OPS[0].op, confirm: true,
    });
    expect(env.isError).toBe(true);
    const after = await stack.prisma.kbDoc.findUniqueOrThrow({ where: { id: stack.fx.ids.canvasId } });
    expect(after.content).toBe(before.content);
    expect(after.contentVersion).toBe(before.contentVersion);
  });

  it("stdio 同款一发：arrow-line create -> UNSUPPORTED_OPERATION", async () => {
    const r = await stdio.client.callTool({
      name: "canvas.commit_elements",
      arguments: { docId: stack.fx.ids.canvasId, ops: [FUTURE_CANVAS_OPS[0].op], confirm: true },
    });
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content as Array<{ text?: string }>)[0]?.text ?? "{}") as { code: string; supported: string[] };
    expect(body.code).toBe("UNSUPPORTED_OPERATION");
    expect(body.supported).toEqual(EXPECTED_SUPPORTED);
    recordAttack({ id: "AC-M6-3/arrow-line", entry: "stdio", input: "commit_elements ops=[arrow-line create]", expected: "UNSUPPORTED_OPERATION", actual: "UNSUPPORTED_OPERATION", verdict: "PASS" });
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

  it("stdio 陈旧 baseVersion -> VERSION_CONFLICT + currentVersion（乐观锁在第二入口同样生效）", async () => {
    const read = await stdio.client.callTool({
      name: "doc.get_doc_blocks",
      arguments: { docId: stack.fx.ids.docId, format: "markdown" },
    });
    const cur = (JSON.parse((read.content as Array<{ text?: string }>)[0]?.text ?? "{}") as { contentVersion?: number }).contentVersion ?? 0;
    const r = await stdio.client.callTool({
      name: "doc.append_blocks",
      arguments: { docId: stack.fx.ids.docId, ops: [{ type: "p", text: "stdio 冲突" }], baseVersion: cur - 1 },
    });
    expect(r.isError).toBe(true);
    const body = JSON.parse((r.content as Array<{ text?: string }>)[0]?.text ?? "{}") as { code: string; currentVersion: number };
    expect(body.code).toBe("VERSION_CONFLICT");
    expect(body.currentVersion).toBe(cur);
    recordAttack({ id: "AC-M6-3/409", entry: "stdio", input: `append_blocks baseVersion=${cur - 1}（陈旧）`, expected: "VERSION_CONFLICT + currentVersion", actual: `VERSION_CONFLICT currentVersion=${body.currentVersion}`, verdict: "PASS" });
  });
});

describe("S8-C3 AC-M6-3c 画布二期已开放操作：create/update/move/connect/delete 真实成功往返", () => {
  /**
   * 用一个原子混批把生命周期走完：建两个矩形 -> 连线 -> 改 A 的填充 -> 移 B -> 删 A（级联删连线）。
   * 成功后板上只剩被移动后的 B。回执各 id 集合与操作一一对应。
   * 该 describe 在 3b 的拒绝用例之后跑，属各自独立的新写入（不依赖 3b 数据）。
   */
  it("HTTP 混批一次成功，回执 created/connected/updated/moved/deleted 分类正确", async () => {
    const r = await callTool(stack.tcp.target, stack.fx.pat.full.token, "canvas.commit_elements", {
      docId: stack.fx.ids.canvasId,
      confirm: true,
      ops: [
        { op: "element.create", element: rect() },
        { op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[200, 0], [300, 100]] } },
      ],
    });
    expect(r.isError ?? false, r.text).toBe(false);
    const created = parseText<{ createdIds: string[]; elementCount: number }>(r);
    expect(created.createdIds).toHaveLength(2);
    const [idA, idB] = created.createdIds;

    // connect（arrow-line 绑两端）+ update A 填充 + move B
    const r2 = await callTool(stack.tcp.target, stack.fx.pat.full.token, "canvas.commit_elements", {
      docId: stack.fx.ids.canvasId,
      confirm: true,
      ops: [
        { op: "element.connect", type: "arrow-line", sourceId: idA, targetId: idB },
        { op: "element.update", id: idA, patch: { fill: "#FF0000" } },
        { op: "element.move", id: idB, dx: 10, dy: 20 },
      ],
    });
    expect(r2.isError ?? false, r2.text).toBe(false);
    const mid = parseText<{ connectedIds: string[]; updatedIds: string[]; movedIds: string[] }>(r2);
    expect(mid.connectedIds).toHaveLength(1);
    expect(mid.updatedIds).toEqual([idA]);
    expect(mid.movedIds).toEqual([idB]);

    // delete A：级联删除绑定它的 arrow-line
    const r3 = await callTool(stack.tcp.target, stack.fx.pat.full.token, "canvas.commit_elements", {
      docId: stack.fx.ids.canvasId,
      confirm: true,
      ops: [{ op: "element.delete", id: idA }],
    });
    expect(r3.isError ?? false, r3.text).toBe(false);
    const del = parseText<{ deletedIds: string[] }>(r3);
    expect(del.deletedIds).toContain(idA);
    expect(del.deletedIds).toContain(mid.connectedIds[0]); // 连线被级联删除
    recordAttack({ id: "AC-M6-3c/positive", entry: "http", input: "create/connect/update/move/delete", expected: "全部成功 + 回执分类正确", actual: "成功，删除级联生效", verdict: "PASS" });

    // 经协议读回：A 与连线已不在；B 存在且 points 已平移
    const board = parseText<{ elements: Array<Record<string, unknown>> }>(
      await callTool(stack.tcp.target, stack.fx.pat.full.token, "canvas.get_board", { docId: stack.fx.ids.canvasId }),
    );
    const byId = new Map(board.elements.map((e) => [e.id as string, e]));
    expect(byId.has(idA)).toBe(false);
    expect(byId.has(mid.connectedIds[0])).toBe(false);
    const b = byId.get(idB);
    expect(b).toBeTruthy();
    expect(b?.points).toEqual([[210, 20], [310, 120]]);
  });

  it("无效目标（update 不存在的 id）-> INVALID_PARAMS，且整批未落库", async () => {
    const before = await stack.prisma.kbDoc.findUniqueOrThrow({ where: { id: stack.fx.ids.canvasId } });
    const env = await callTool(stack.tcp.target, stack.fx.pat.full.token, "canvas.commit_elements", {
      docId: stack.fx.ids.canvasId, confirm: true,
      ops: [{ op: "element.update", id: "ghost-id", patch: { fill: "#000000" } }],
    });
    expect(env.isError).toBe(true);
    const body = parseText<{ code: string }>(env);
    expect(body.code).toBe("INVALID_PARAMS");
    const after = await stack.prisma.kbDoc.findUniqueOrThrow({ where: { id: stack.fx.ids.canvasId } });
    expect(after.content).toBe(before.content);
    expect(after.contentVersion).toBe(before.contentVersion);
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
