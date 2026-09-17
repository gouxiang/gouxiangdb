// M6/S6 canvas 族只读工具：canvas.get_board（画布只读；**画布写入是 S6b 的 canvas.commit_elements**）。
//
// 纪律（同 doc.tools.ts）：handler 只编排——资源判定经权限端口（M4 闸门二，action r），
// 正文读经 domain/mcpDocModels（mcp/** 内不裸查 prisma）。本工具**只读，不写任何 content**。
//
// 数据事实（已核实）：
//   1. 画布 content 是 **PlaitElement[] 的 JSON 字符串，顶层就是数组**（DrawnixCanvas.tsx:201
//      `safeParse(content)` 产 PlaitElement[]；:303 保存即 `JSON.stringify(els)`）——不是 `{children}` 对象。
//   2. **未知键必须透传不剥离**（计划 §S6 / ARCH §8.5）：elements 原样返回解析结果，不做任何字段裁剪。
//   3. **viewport 未持久化**：保存载荷仅 `{content, baseVersion}`（useDocPersistence.ts:79），
//      viewport 是 board 运行时视图态（DrawnixCanvas.tsx:52/165-194 的 BoardTransforms 缩放平移，不进数据）。
//      故本工具如实返回 `viewport: null`，**不臆造字段**。

import { parseBoardContent } from "@gx/canvas";
import { docBriefById } from "../../domain/mcpDocModels.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

// 解析口径（空/坏 JSON/非数组）与写侧 canvas.commit_elements 共用 @gx/canvas.parseBoardContent 单一真源：
// 读侧宽容返回 parseError 标志（不抛、不吞），写侧据 parseError 拒绝写入。

/**
 * canvas.get_board：画布只读。
 * 前置（口径与 doc 工具一致）：端口非空 -> 画布节点 r -> kind 必须为 "canvas"（传 doc 类 id 不得拿到内容）。
 * 回参：{docId, kind, title, contentVersion, elementCount, elements, viewport, parseError}。
 */
export async function canvasGetBoard(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  const docId = String(args.docId ?? "");
  if (!(await ctx.port.can("r", { kind: "canvas", id: docId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权访问该画布（或该画布不存在）");
  }
  const doc = await docBriefById(docId);
  // kind 不匹配（传 doc 类 id）：同口径拒绝，不泄漏"这是个存在的文档"
  if (!doc || doc.kind !== "canvas") {
    return deny("FORBIDDEN_RESOURCE", "画布不存在或类型不匹配");
  }
  const { elements, parseError } = parseBoardContent(doc.content);
  return text(JSON.stringify({
    docId: doc.id,
    kind: doc.kind,
    title: doc.title,
    contentVersion: doc.contentVersion,
    elementCount: elements.length,
    // 未知键透传：直接返回解析结果（PlaitElement[]），不做字段白名单/裁剪（ARCH §8.5）
    elements,
    // 未持久化（见文件头注释 3）：如实 null，不臆造
    viewport: null,
    parseError,
  }));
}
