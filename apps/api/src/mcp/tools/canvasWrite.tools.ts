// M6/S6b canvas 写入工具：canvas.commit_elements（element.create 最小集：geometry/rectangle 尾插）。
//
// 纪律（同 doc.tools.ts）：handler 只编排——
//   资源判定经权限端口（M4 闸门二，action u）；content 读经 domain/mcpDocModels；
//   六不变量判定经 @gx/canvas（纯函数唯一真源，本文件不重抄形状规则）；
//   落盘复用 withWriteTx("doc.content.save") + saveDocContentTx（与 REST PUT /docs/:id/content、
//   doc 写工具**同一事务体/同一乐观锁/同一 searchText 投影**）。
//
// 乐观锁口径与 doc 写工具完全一致：baseVersion 可选（缺省 LWW，只写身份可用）；
// 陈旧版本 -> isError + {code:"VERSION_CONFLICT",currentVersion}（HTTP 200，协议错误不走 4xx）。
// 写后回执：有 canvas r -> {ok,contentVersion,elementCount,appendedIds}；只写身份 -> 精简 {ok:true}。

import { parseBoardContent, validateCreateOps } from "@gx/canvas";
import { withWriteTx } from "../../db.js";
import { buildSearchText } from "../../domain/kb.js";
import { saveDocContentTx, VersionConflictError } from "../../domain/kbDocWrite.js";
import { docBriefById } from "../../domain/mcpDocModels.js";
import { MCP_LIMITS } from "./schemas.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

/** UNSUPPORTED_OPERATION 协议错误（deny 联合无此 code，仿 VersionConflict 直接构造 ToolResult）。 */
function unsupported(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ code: "UNSUPPORTED_OPERATION", supported: ["element.create"], message }) }],
    isError: true,
  };
}

/** 配额单源在 api 侧 MCP_LIMITS（shared 的 DEFAULT_CANVAS_LIMITS 同值；此处显式传入避免两份常量漂移）。 */
const COMMIT_LIMITS = {
  maxOps: MCP_LIMITS.WRITE_OPS_MAX,
  maxBatchBytes: MCP_LIMITS.WRITE_TEXT_MAX_BYTES,
  maxBoardBytes: MCP_LIMITS.DOC_CANVAS_MAX_BYTES,
};

/**
 * canvas.commit_elements：校验一批 element.create 并尾插到画布。
 * 前置（与 get_board 同口径）：端口非空 -> canvas 节点 u -> doc 存在且 kind==="canvas"。
 */
export async function canvasCommitElements(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  if (!ctx.port) return deny("FORBIDDEN_RESOURCE", "权限引擎未接入");
  const docId = String(args.docId ?? "");
  if (!(await ctx.port.can("u", { kind: "canvas", id: docId }))) {
    return deny("FORBIDDEN_RESOURCE", "无权写入该画布（或该画布不存在）");
  }
  const doc = await docBriefById(docId);
  if (!doc || doc.kind !== "canvas") {
    return deny("FORBIDDEN_RESOURCE", "画布不存在或类型不匹配");
  }

  // 写路径解析：存量内容坏 JSON / 顶层非数组必须拒绝写入（不沿用读侧宽容口径，绝不覆盖已损坏内容）
  const parsed = parseBoardContent(doc.content);
  if (parsed.parseError) {
    return deny("INVALID_PARAMS", "当前画布内容无法解析为元素数组，拒绝写入以避免破坏既有数据（请先经画布修复内容）");
  }

  const ops = Array.isArray(args.ops) ? args.ops : [];
  const v = validateCreateOps(parsed.elements, ops, COMMIT_LIMITS);
  if (!v.ok) {
    // 未开放操作名（element.update/move/delete/connect、zorder…）/ arrow-line / 关联块 -> UNSUPPORTED_OPERATION
    if (v.code === "UNSUPPORTED_OPERATION") return unsupported(v.message);
    return deny("INVALID_PARAMS", v.message);
  }

  // 落库 content = 尾插后完整数组 JSON（与前端 JSON.stringify(els) 同形）；整板 10MB 已在 shared 内按 UTF-8 校验
  const content = JSON.stringify(v.next);
  const searchText = buildSearchText("canvas", content);
  // 缺省（未携带）-> undefined（LWW）。绝不可 Number(undefined)：NaN 会误入条件更新分支恒冲突（S5 教训）。
  const baseVersion = typeof args.baseVersion === "number" ? args.baseVersion : undefined;

  try {
    const result = await withWriteTx("doc.content.save", (tx) =>
      saveDocContentTx(tx, {
        docId: doc.id,
        kind: "canvas",
        currentVersion: doc.contentVersion,
        content,
        searchText,
        userId: ctx.subject.userId,
        baseVersion,
      }),
    );
    // 写后回执分流：有 canvas r 才回派生值（版本/元素数/新 id）；只写身份 -> 精简 {ok:true}（防派生值泄漏）
    const canRead = await ctx.port.can("r", { kind: "canvas", id: doc.id });
    return text(
      JSON.stringify(
        canRead
          ? { ok: true, contentVersion: result.contentVersion, elementCount: v.next.length, appendedIds: v.appendedIds }
          : { ok: true },
      ),
    );
  } catch (e) {
    if (e instanceof VersionConflictError) {
      return {
        content: [{ type: "text", text: JSON.stringify({ code: "VERSION_CONFLICT", message: e.message, currentVersion: e.currentVersion }) }],
        isError: true,
      };
    }
    throw e;
  }
}
