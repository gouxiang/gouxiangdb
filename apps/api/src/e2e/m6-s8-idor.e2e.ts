// M6/S8-C5 IDOR 四条：base / doc / canvas-read / canvas-write。
//
// 对抗口径（真攻击，不是 404 冒烟）：拿**真实存在但对该主体不可见**的资源 id 与**根本不存在**的 id 各打一发，
// 断言两发响应**逐字节一致**——即"无权"与"不存在"不可区分，零存在性泄漏（AC-M6-1 同族要求）。
// 夹具侧先断言隐藏资源在库里确实存在（否则就是退化成 404 测试，对抗不成立）。
//
// 隐藏资源由 uOther 创建（M4 的 createdBy 属主路径会让"自己建的"资源可见——probe 实测踩到过，见 fixtures.ts）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapE2e, type E2eStack } from "./bootstrap.js";
import { callTool, type ToolEnvelope } from "./serverHarness.js";
import { openStdioClient, type SdkConnection } from "./clientHarness.js";
import { dumpAttackMatrix, recordAttack } from "./attackLog.js";

let stack: E2eStack;
let stdio: SdkConnection;

/** 单条 IDOR：隐藏 vs 不存在，逐字节对拍。 */
async function idor(tool: string, args: Record<string, unknown>, idKey: string, hidden: string, ghost: string): Promise<{ text: string; code: string }> {
  const token = stack.fx.pat.full.token;
  const hit = await callTool(stack.tcp.target, token, tool, { ...args, [idKey]: hidden });
  const miss = await callTool(stack.tcp.target, token, tool, { ...args, [idKey]: ghost });
  expect(hit.isError, `${tool} 对不可见资源必须拒绝`).toBe(true);
  expect(miss.isError, `${tool} 对不存在资源必须拒绝`).toBe(true);
  expect(JSON.parse(hit.text), `${tool} 响应不得内嵌资源 id`).toEqual(JSON.parse(miss.text));
  expect(hit.text, `${tool} 隐藏与不存在必须逐字节一致`).toBe(miss.text);
  return { text: hit.text, code: (JSON.parse(hit.text) as { code: string }).code };
}

beforeAll(async () => {
  stack = await bootstrapE2e("gx-m6-s8-idor-");
  stdio = await openStdioClient(stack.fx.pat.full.token);
}, 240_000);

afterAll(async () => {
  dumpAttackMatrix();
  await stdio?.close();
  await stack?.close();
});

describe("S8-C5 前置：隐藏资源确实存在（否则不构成 IDOR 对抗）", () => {
  it("三条隐藏资源在库内可直读，且不在该令牌可见集内", async () => {
    const { ids } = stack.fx;
    expect(await stack.prisma.base.findUnique({ where: { id: ids.hiddenBaseId } })).not.toBeNull();
    expect(await stack.prisma.kbDoc.findUnique({ where: { id: ids.hiddenDocId } })).not.toBeNull();
    expect(await stack.prisma.kbDoc.findUnique({ where: { id: ids.hiddenCanvasId } })).not.toBeNull();
    // 可见集不含隐藏项（闸门一可见集口径）
    const bases = await callTool(stack.tcp.target, stack.fx.pat.full.token, "table.list_bases", {});
    expect(bases.text).not.toContain(ids.hiddenBaseId);
    expect(bases.text).toContain(ids.baseId);
  });
});

describe("S8-C5 IDOR 四条：隐藏 vs 不存在逐字节一致（零存在性泄漏）", () => {
  it("base：table.get_schema 不可见 base", async () => {
    const r = await idor("table.get_schema", {}, "baseId", stack.fx.ids.hiddenBaseId, stack.fx.ghost.baseId);
    expect(r.code).toBe("FORBIDDEN_RESOURCE");
    recordAttack({ id: "IDOR-base", entry: "http", input: "get_schema 传不可见 baseId（存在）vs 不存在 id", expected: "FORBIDDEN_RESOURCE 且两发逐字节一致", actual: "FORBIDDEN_RESOURCE，逐字节一致", verdict: "PASS" });
  });

  it("doc：doc.get_doc_blocks 不可见文档", async () => {
    const r = await idor("doc.get_doc_blocks", { format: "markdown" }, "docId", stack.fx.ids.hiddenDocId, stack.fx.ghost.docId);
    expect(r.code).toBe("FORBIDDEN_RESOURCE");
    recordAttack({ id: "IDOR-doc", entry: "http", input: "get_doc_blocks 传不可见 docId vs 不存在 id", expected: "FORBIDDEN_RESOURCE 且两发逐字节一致", actual: "FORBIDDEN_RESOURCE，逐字节一致", verdict: "PASS" });
  });

  it("canvas-read：canvas.get_board 不可见画布", async () => {
    const r = await idor("canvas.get_board", {}, "docId", stack.fx.ids.hiddenCanvasId, stack.fx.ghost.canvasId);
    expect(r.code).toBe("FORBIDDEN_RESOURCE");
    recordAttack({ id: "IDOR-canvas-read", entry: "http", input: "get_board 传不可见 canvasId vs 不存在 id", expected: "FORBIDDEN_RESOURCE 且两发逐字节一致", actual: "FORBIDDEN_RESOURCE，逐字节一致", verdict: "PASS" });
  });

  it("canvas-write：canvas.commit_elements 不可见画布（写侧同一口径）", async () => {
    const ops = [{ op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[0, 0], [1, 1]] } }];
    const r = await idor("canvas.commit_elements", { ops, confirm: true }, "docId", stack.fx.ids.hiddenCanvasId, stack.fx.ghost.canvasId);
    expect(r.code).toBe("FORBIDDEN_RESOURCE");
    // 隐藏画布内容零改动（拒绝不是"悄悄写成功"）
    expect((await stack.prisma.kbDoc.findUniqueOrThrow({ where: { id: stack.fx.ids.hiddenCanvasId } })).content).toBe("[]");
    recordAttack({ id: "IDOR-canvas-write", entry: "http", input: "commit_elements 传不可见 canvasId vs 不存在 id", expected: "FORBIDDEN_RESOURCE 且两发逐字节一致", actual: "FORBIDDEN_RESOURCE，逐字节一致", verdict: "PASS" });
  });

  it("表族同族补证：record.list_records 打不可见表", async () => {
    const hit = await callTool(stack.tcp.target, stack.fx.pat.full.token, "record.list_records", { tableId: stack.fx.ids.hiddenTableId, limit: 5 });
    const miss = await callTool(stack.tcp.target, stack.fx.pat.full.token, "record.list_records", { tableId: "tbl_ghost", limit: 5 });
    expect(hit.isError).toBe(true);
    expect(hit.text).toBe(miss.text);
    expect((JSON.parse(hit.text) as { code: string }).code).toBe("FORBIDDEN_RESOURCE");
  });
});

describe("S8-C5 stdio 入口 IDOR 两族（doc 读 / canvas 写，第二入口不放宽）", () => {
  it("stdio：不可见 doc 与不存在 doc 逐字节一致（FORBIDDEN_RESOURCE）", async () => {
    const argsFor = (docId: string) => ({ docId, format: "markdown" });
    const hit = await stdio.client.callTool({ name: "doc.get_doc_blocks", arguments: argsFor(stack.fx.ids.hiddenDocId) });
    const miss = await stdio.client.callTool({ name: "doc.get_doc_blocks", arguments: argsFor(stack.fx.ghost.docId) });
    const hitText = (hit.content as Array<{ text?: string }>)[0]?.text ?? "";
    const missText = (miss.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(hit.isError).toBe(true);
    expect(miss.isError).toBe(true);
    expect(hitText).toBe(missText);
    expect((JSON.parse(hitText) as { code: string }).code).toBe("FORBIDDEN_RESOURCE");
    recordAttack({ id: "IDOR-doc", entry: "stdio", input: "get_doc_blocks 不可见 docId vs 不存在 id", expected: "FORBIDDEN_RESOURCE 且两发逐字节一致", actual: "FORBIDDEN_RESOURCE，逐字节一致", verdict: "PASS" });
  });

  it("stdio：不可见 canvas 直调 commit_elements 与不存在 canvas 同口径", async () => {
    const argsFor = (docId: string) => ({ docId, ops: [{ op: "element.create", element: { type: "geometry", shape: "rectangle", points: [[0, 0], [1, 1]] } }], confirm: true });
    const hit = await stdio.client.callTool({ name: "canvas.commit_elements", arguments: argsFor(stack.fx.ids.hiddenCanvasId) });
    const miss = await stdio.client.callTool({ name: "canvas.commit_elements", arguments: argsFor(stack.fx.ghost.canvasId) });
    const hitText = (hit.content as Array<{ text?: string }>)[0]?.text ?? "";
    const missText = (miss.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(hit.isError).toBe(true);
    expect(miss.isError).toBe(true);
    expect(hitText).toBe(missText);
    expect((JSON.parse(hitText) as { code: string }).code).toBe("FORBIDDEN_RESOURCE");
    recordAttack({ id: "IDOR-canvas-write", entry: "stdio", input: "commit_elements 不可见 canvasId vs 不存在 id", expected: "FORBIDDEN_RESOURCE 且两发逐字节一致", actual: "FORBIDDEN_RESOURCE，逐字节一致", verdict: "PASS" });
  });
});

describe("S8-C5 反例护栏：可见资源仍可正常读（证明拒绝只因权限，不是工具坏了）", () => {
  it("可见 base / doc / canvas 均正常返回", async () => {
    const token = stack.fx.pat.full.token;
    const schema = await callTool(stack.tcp.target, token, "table.get_schema", { baseId: stack.fx.ids.baseId });
    const doc = await callTool(stack.tcp.target, token, "doc.get_doc_blocks", { docId: stack.fx.ids.docId, format: "markdown" });
    const cv = await callTool(stack.tcp.target, token, "canvas.get_board", { docId: stack.fx.ids.canvasId });
    for (const [label, env] of [["schema", schema], ["doc", doc], ["canvas", cv]] as Array<[string, ToolEnvelope]>) {
      expect(env.isError ?? false, label).toBe(false);
      expect(env.text.length, label).toBeGreaterThan(0);
    }
  });
});
