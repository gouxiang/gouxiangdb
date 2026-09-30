// MCP doc 族内容创建工具：doc.create_doc / canvas.create_canvas。
//
// 纪律：handler 只编排——资源判定经权限端口（kb 节点 c，M4 闸门二），创建经
// domain/contentService（REST POST docs 与 MCP 同一事务体），本文件不 import 旧守卫、不裸查 prisma。
// 权限口径与 REST 的 contentAccessOf(access).create 同语义：doc 与 canvas 共用知识库 content 档位。
// 归属说明：两工具 family 均为 "doc"、actions ["c"]——创建时目标实体尚不存在，
//   闸门一只能按 kb 节点的 c 可见集放行（不能归 canvas 族，否则永不入册）。
// 写而无对应资源 r 时回精简回执。

import { createContent } from "../../domain/contentService.js";
import { kbBriefById } from "../../domain/mcpReadModels.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

function noEngine(): ToolResult {
  return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
}

/** 在 kb 节点判 c + 确认 kb 存在；返回拒绝结果或通过。 */
async function canCreateInKb(ctx: ToolCtx, kbId: string): Promise<ToolResult | true> {
  if (!(await ctx.port!.can("c", { kind: "kb", id: kbId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权在该知识库创建内容（或该知识库不存在）");
  }
  const kb = await kbBriefById(kbId);
  if (!kb) return deny("FORBIDDEN_RESOURCE", "知识库不存在");
  return true;
}

/** doc.create_doc：kb 节点 c；可带 parentId 建层级文档。 */
export async function docCreateDoc(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return noEngine();
  const kbId = String(args.kbId ?? "");
  const gate = await canCreateInKb(ctx, kbId);
  if (gate !== true) return gate;

  const parentId = args.parentId === undefined || args.parentId === null
    ? null
    : String(args.parentId);
  const d = await createContent(
    { kbId, kind: "doc", title: String(args.title ?? ""), parentId },
    ctx.subject.userId,
  );
  const canRead = await ctx.port.can("r", { kind: "doc", id: d.id });
  return text(JSON.stringify(canRead
    ? { ok: true, docId: d.id }
    : { ok: true }));
}

/** canvas.create_canvas：kb 节点 c；画布恒挂 kb 下（不支持层级）。 */
export async function canvasCreateCanvas(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return noEngine();
  const kbId = String(args.kbId ?? "");
  const gate = await canCreateInKb(ctx, kbId);
  if (gate !== true) return gate;

  const d = await createContent(
    { kbId, kind: "canvas", title: String(args.title ?? "") },
    ctx.subject.userId,
  );
  const canRead = await ctx.port.can("r", { kind: "canvas", id: d.id });
  return text(JSON.stringify(canRead
    ? { ok: true, canvasId: d.id }
    : { ok: true }));
}
