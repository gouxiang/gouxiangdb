// M6/S6b + #622 canvas 写入工具：canvas.commit_elements
// （element.create/update/move/delete/connect 混批；connect 支持 arrow-line 两端绑定 + vector-line 自由点）。
//
// 纪律（同 doc.tools.ts）：handler 只编排——
//   资源判定经权限端口（M4 闸门二，action u）；content 读经 domain/mcpDocModels；
//   图元规则判定经 @gx/canvas 的 commitElements（纯函数唯一真源，本文件不重抄形状规则）；
//   落盘复用 withWriteTx("doc.content.save") + saveDocContentTx（与 REST PUT /docs/:id/content、
//   doc 写工具**同一事务体/同一乐观锁/同一 searchText 投影**）。
//
// 乐观锁口径与 doc 写工具完全一致：baseVersion 可选（缺省 LWW，只写身份可用）；
// 陈旧版本 -> isError + {code:"VERSION_CONFLICT",currentVersion}（HTTP 200，协议错误不走 4xx）。
// 写后回执：有 canvas r -> 完整回执（版本/元素数/新建/连接/更新/移动/删除 id）；只写身份 -> 精简 {ok:true}。

import { commitElements, parseBoardContent } from "@gx/canvas";
import { withWriteTx } from "../../db.js";
import { buildSearchText } from "../../domain/kb.js";
import { saveDocContentTx, VersionConflictError } from "../../domain/kbDocWrite.js";
import { docBriefById } from "../../domain/mcpDocModels.js";
import { MCP_LIMITS } from "./schemas.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";

/** UNSUPPORTED_OPERATION 协议错误（deny 联合无此 code，仿 VersionConflict 直接构造 ToolResult）。 */
function unsupported(message: string, supported: string[]): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ code: "UNSUPPORTED_OPERATION", supported, message }) }],
    isError: true,
  };
}

/** 配额单源在 api 侧 MCP_LIMITS（shared 的 DEFAULT_CANVAS_LIMITS 同值；显式传入避免两份常量漂移）。 */
const COMMIT_LIMITS = {
  maxOps: MCP_LIMITS.WRITE_OPS_MAX,
  maxBatchBytes: MCP_LIMITS.WRITE_TEXT_MAX_BYTES,
  maxBoardBytes: MCP_LIMITS.DOC_CANVAS_MAX_BYTES,
};
const SUPPORTED = [
  "element.create",
  "element.update",
  "element.move",
  "element.delete",
  "element.connect",
];

/**
 * canvas.commit_elements：原子应用一批图元增删改移连操作。
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

  // 存量内容坏 JSON / 顶层非数组必须拒绝写入（不沿用读侧宽容口径，绝不覆盖已损坏内容）
  const parsed = parseBoardContent(doc.content);
  if (parsed.parseError) {
    return deny("INVALID_PARAMS", "当前画布内容无法解析为元素数组，拒绝写入以避免破坏既有数据（请先经画布修复内容）");
  }

  const v = commitElements(parsed.elements, args.ops, COMMIT_LIMITS);
  if (!v.ok) {
    if (v.code === "UNSUPPORTED_OPERATION") return unsupported(v.message, v.supported ? [...v.supported] : SUPPORTED);
    return deny("INVALID_PARAMS", v.message);
  }

  const content = JSON.stringify(v.next);
  const searchText = buildSearchText("canvas", content);
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
    const canRead = await ctx.port.can("r", { kind: "canvas", id: doc.id });
    return text(
      JSON.stringify(
        canRead
          ? {
              ok: true,
              contentVersion: result.contentVersion,
              elementCount: v.next.length,
              createdIds: v.createdIds,
              connectedIds: v.connectedIds,
              updatedIds: v.updatedIds,
              movedIds: v.movedIds,
              deletedIds: v.deletedIds,
            }
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
