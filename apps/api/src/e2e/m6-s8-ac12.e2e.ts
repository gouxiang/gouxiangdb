// M6/S8-C1/C2 对抗：AC-M6-1（只读凭证无写工具 + 直调不泄漏存在性）、AC-M6-2（字段受限凭证）。
// **两个入口各跑一遍**（HTTP 与 stdio 共用同一 buildServer，正好互为交叉验证）。
//
// 对抗口径（"真攻击"）：先构造应被拒的输入 → 断言**拒绝码**；不许拿 happy path 充数。
// 台账三列（输入 → 期望码 → 实际码）经 recordAttack 落到 afterAll 的矩阵表，供 baseline 直接引用。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { bootstrapE2e, type E2eStack } from "./bootstrap.js";
import { callTool, listTools, parseText, type ToolEnvelope } from "./serverHarness.js";
import { openStdioClient, type SdkConnection } from "./clientHarness.js";
import { dumpAttackMatrix, recordAttack } from "./attackLog.js";

/** 全部写工具（AC-M6-1：只读凭证的 tools/list 必须一个都没有）。 */
const WRITE_TOOLS = [
  "record.create_record", "record.update_record", "record.delete_record",
  "doc.append_blocks", "doc.update_block", "doc.delete_blocks",
  "canvas.commit_elements",
];

let stack: E2eStack;
/** 两个身份的 stdio 客户端：ro（AC-M6-1）与 mask（AC-M6-2）——绝不能共用一个令牌当两种身份用。 */
let stdioRo: SdkConnection;
let stdioMask: SdkConnection;

/** 未注册工具的错误文案内嵌客户端传来的工具名 → 逐字节比较前先把名字归一化。 */
const normTool = (text: string, name: string): string => text.split(name).join("<TOOL>");

/** HTTP 入口：直接调用被裁工具 vs 真不存在的工具名，比较响应是否同口径。 */
async function probeUnknownHttp(tool: string): Promise<ToolEnvelope> {
  return await callTool(stack.tcp.target, stack.fx.pat.ro.token, tool, {});
}

/** stdio 入口：同一件事（SDK 客户端形态）。 */
async function probeUnknownStdio(client: Client, tool: string): Promise<{ isError: boolean; text: string }> {
  const r = await client.callTool({ name: tool, arguments: {} });
  return { isError: r.isError === true, text: (r.content as Array<{ text?: string }>)[0]?.text ?? "" };
}

beforeAll(async () => {
  stack = await bootstrapE2e("gx-m6-s8-ac12-");
  stdioRo = await openStdioClient(stack.fx.pat.ro.token);
  stdioMask = await openStdioClient(stack.fx.pat.mask.token);
}, 240_000);

afterAll(async () => {
  dumpAttackMatrix();
  await stdioMask?.close();
  await stdioRo?.close();
  await stack?.close();
});

describe("S8-C1 AC-M6-1 只读凭证：tools/list 无写工具 + 直调与「不存在」同口径", () => {
  it("HTTP tools/list 恰为读工具（零写工具），且集合精确匹配", async () => {
    const names = await listTools(stack.tcp.target, stack.fx.pat.ro.token);
    expect(names).toEqual([
      "canvas.get_board", "doc.get_doc_blocks", "ping_echo",
      "record.list_records", "record.query_records", "table.get_schema", "table.list_bases",
    ]);
    expect(names.filter((n) => WRITE_TOOLS.includes(n))).toEqual([]);
  });

  it("HTTP 直调被裁写工具 -> 与「真不存在」同口径（仅工具名占位不同），不泄漏存在性", async () => {
    const carved = await probeUnknownHttp("record.create_record");
    const ghost = await probeUnknownHttp("no.such_tool");
    expect(carved.status).toBe(200);
    expect(carved.isError).toBe(true);
    expect(ghost.isError).toBe(true);
    expect(carved.text).toContain("-32602");
    // 派工单要求"逐字节一致"：SDK 的未注册工具文案形如 `MCP error -32602: Tool <name> not found`，
    // 名字是**客户端自己传的**，故逐字节一致只能在"名字占位归一化"后成立——这是构造使然，非泄漏。
    expect(normTool(carved.text, "record.create_record")).toBe(normTool(ghost.text, "no.such_tool"));
    recordAttack({ id: "AC-M6-1", entry: "http", input: "直调被裁工具 record.create_record", expected: "-32602 / UNKNOWN_TOOL", actual: "isError + -32602（与不存在工具同文案模板）", verdict: "PASS" });
  });

  it("stdio tools/list 与 HTTP 同集合（共用 buildServer，闸门一决策一致）", async () => {
    const names = (await stdioRo.client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "canvas.get_board", "doc.get_doc_blocks", "ping_echo",
      "record.list_records", "record.query_records", "table.get_schema", "table.list_bases",
    ]);
  });

  it("stdio 直调被裁写工具 -> 与「真不存在」同口径", async () => {
    const carved = await probeUnknownStdio(stdioRo.client, "canvas.commit_elements");
    const ghost = await probeUnknownStdio(stdioRo.client, "no.such_tool");
    expect(carved.isError).toBe(true);
    expect(ghost.isError).toBe(true);
    expect(carved.text).toContain("-32602");
    expect(normTool(carved.text, "canvas.commit_elements")).toBe(normTool(ghost.text, "no.such_tool"));
    recordAttack({ id: "AC-M6-1", entry: "stdio", input: "直调被裁工具 canvas.commit_elements", expected: "-32602 / UNKNOWN_TOOL", actual: "isError + -32602（与不存在工具同文案模板）", verdict: "PASS" });
  });
});

describe("S8-C2 AC-M6-2 字段受限凭证：schema 收窄 / 出参缺席 / 参数二次拦截", () => {
  it("HTTP 写入工具未注册（无 c 动作）——注册集 == 有效动作集", async () => {
    const names = await listTools(stack.tcp.target, stack.fx.pat.mask.token);
    expect(names).toContain("record.update_record"); // 有 u 动作
    expect(names).not.toContain("record.create_record"); // 无 c 动作
    expect(names).not.toContain("record.delete_record"); // 无 d 动作
  });

  it("HTTP get_schema：不可见字段不进 schema", async () => {
    const env = await callTool(stack.tcp.target, stack.fx.pat.mask.token, "table.get_schema", { baseId: stack.fx.ids.baseId });
    const body = parseText<{ tables: Array<{ fields: Array<{ fieldId: string }> }> }>(env);
    const ids = body.tables.flatMap((t) => t.fields.map((f) => f.fieldId));
    expect(ids).toEqual([stack.fx.ids.fVisible]);
    expect(ids).not.toContain(stack.fx.ids.fHidden);
    recordAttack({ id: "AC-M6-2", entry: "http", input: "字段受限令牌读 get_schema", expected: "schema 不含不可见字段", actual: `fields=[${ids.length}] 仅可见列`, verdict: "PASS" });
  });

  it("HTTP list_records：不可见字段在返回中物理缺席", async () => {
    const env = await callTool(stack.tcp.target, stack.fx.pat.mask.token, "record.list_records", { tableId: stack.fx.ids.tableId, limit: 10 });
    const body = parseText<{ records: Array<{ fields: Record<string, unknown> }> }>(env);
    expect(body.records.length).toBeGreaterThan(0);
    for (const r of body.records) {
      expect(Object.keys(r.fields)).toEqual([stack.fx.ids.fVisible]);
      expect(Object.keys(r.fields)).not.toContain(stack.fx.ids.fHidden);
    }
    recordAttack({ id: "AC-M6-2", entry: "http", input: "字段受限令牌读 list_records", expected: "返回物理缺席不可见字段", actual: `fields 仅 [可见列] × ${body.records.length} 条`, verdict: "PASS" });
  });

  it("HTTP 参数越权（拿可见令牌传不可见 fieldId）-> FORBIDDEN_FIELD", async () => {
    const env = await callTool(stack.tcp.target, stack.fx.pat.mask.token, "record.update_record", {
      tableId: stack.fx.ids.tableId, recordId: "whatever", fields: { [stack.fx.ids.fHidden]: "x" },
    });
    expect(env.isError).toBe(true);
    expect(parseText<{ code: string }>(env).code).toBe("FORBIDDEN_FIELD");
    recordAttack({ id: "AC-M6-2", entry: "http", input: "update_record 传不可见 fieldId", expected: "FORBIDDEN_FIELD", actual: "FORBIDDEN_FIELD", verdict: "PASS" });
  });

  it("stdio 同款两条：schema 收窄 + 参数越权拦截", async () => {
    const schema = await stdioMask.client.callTool({ name: "table.get_schema", arguments: { baseId: stack.fx.ids.baseId } });
    const ids = (JSON.parse((schema.content as Array<{ text?: string }>)[0]?.text ?? "{}") as { tables: Array<{ fields: Array<{ fieldId: string }> }> })
      .tables.flatMap((t) => t.fields.map((f) => f.fieldId));
    expect(ids).toEqual([stack.fx.ids.fVisible]);

    const bad = await stdioMask.client.callTool({
      name: "record.update_record",
      arguments: { tableId: stack.fx.ids.tableId, recordId: "whatever", fields: { [stack.fx.ids.fHidden]: "x" } },
    });
    expect(bad.isError).toBe(true);
    expect(JSON.parse((bad.content as Array<{ text?: string }>)[0]?.text ?? "{}")).toMatchObject({ code: "FORBIDDEN_FIELD" });
    recordAttack({ id: "AC-M6-2", entry: "stdio", input: "update_record 传不可见 fieldId", expected: "FORBIDDEN_FIELD", actual: "FORBIDDEN_FIELD", verdict: "PASS" });
  });
});
