// M6/S5 doc 族工具：doc.get_doc_blocks / append_blocks / update_block / delete_blocks。
//
// 纪律：handler 只编排——资源判定经权限端口（M4 闸门二，action r/u），正文读经 domain/mcpDocModels，
// 写经 domain/kbDocWrite.saveDocContentTx（**与 REST PUT /docs/:docId/content 同一事务体**）。
// 块/Markdown 双向转换**唯一真源** = @gx/blocks：读经 mdToBlocks、写经 blocksToMd（唯一 md 序列化出口）。
//
// 铁律：
//   1. AI 不得自带块 id——append 的 op 仅透传属性，块由服务端 newBlock 构造；对外块标识按位置稳定派生
//      （见 withStableIds），入参 shape 已无 id。
//   2. align 只走注释通道——只写 Block.align，由 blocksToMd 序列化为 `<!-- align:x -->`，绝不手写 md。
//   3. 乐观锁可选——写操作可携带 baseVersion，冲突回 isError + `{code:"VERSION_CONFLICT", currentVersion}`（HTTP 200）；
//      缺省即 last-write-wins（与 REST PUT 同口径），使「只写身份」（无 doc:read）不被逼授予读权限（裁决 (b)）。
//   4. 写而无 r 的主体 -> 精简回执 `{ok:true}`（不回 contentVersion，防派生值/时序泄漏）。

import { blocksToMd, mdToBlocks, newBlock, type Block, type BlockType } from "@gx/blocks";
import { withWriteTx } from "../../db.js";
import { buildSearchText } from "../../domain/kb.js";
import { saveDocContentTx, VersionConflictError } from "../../domain/kbDocWrite.js";
import { docBriefById, type DocBrief } from "../../domain/mcpDocModels.js";
import { MCP_LIMITS } from "./schemas.js";
import { deny, text, type ToolCtx, type ToolResult } from "./types.js";
import type { McpAction } from "../permissions/types.js";

/** 读/写前置结果：拒绝时给出已构造的 ToolResult，通过时给出文档投影。 */
type DocGuard = { denied: ToolResult } | { doc: DocBrief };

/**
 * 稳定块标识：Markdown 不持久化块 id（`mdToBlocks` 每次随机生成），故 MCP 对外**按位置派生确定性
 * 标识** `b<seq>`，使 get -> append(afterBlockId)/update/delete 在同一 contentVersion 内可用。
 * 跨版本漂移（他人先写/本端先写）由 baseVersion 乐观锁拦截（VERSION_CONFLICT），调用方重读即得新标识。
 */
function withStableIds(blocks: Block[]): Block[] {
  return blocks.map((b, i) => ({ ...b, id: `b${i}` }));
}

/** 前置：资源可见（闸门二 action）+ 文档存在未删。拒绝口径统一 FORBIDDEN_RESOURCE（不泄漏存在性）。 */
async function guardDoc(ctx: ToolCtx, docId: string, action: McpAction): Promise<DocGuard> {
  if (!ctx.port) return { denied: deny("FORBIDDEN_RESOURCE", "权限引擎未接入") };
  if (!(await ctx.port.can(action, { kind: "doc", id: docId }))) {
    return { denied: deny("FORBIDDEN_RESOURCE", "无权访问该文档（或该文档不存在）") };
  }
  const doc = await docBriefById(docId);
  if (!doc) return { denied: deny("FORBIDDEN_RESOURCE", "文档不存在或已删除") };
  return { doc };
}

/** 递归累计字符串值的 UTF-8 字节数（"批文本"口径：不计对象键名，不计非字符串标量）。 */
function collectBytes(v: unknown): number {
  if (typeof v === "string") return Buffer.byteLength(v, "utf8");
  if (Array.isArray(v)) return v.reduce<number>((n, x) => n + collectBytes(x), 0);
  if (v && typeof v === "object") return Object.values(v).reduce<number>((n, x) => n + collectBytes(x), 0);
  return 0;
}

/**
 * 公共写出口：blocksToMd（唯一 md 序列化）-> buildSearchText（与 REST 同口径）-> 复用
 * saveDocContentTx 条件更新（一次 contentVersion+1），事务名与 REST 一致（"doc.content.save"）。
 * 与 REST PUT 完全同一事务体、同一乐观锁语义、同一检索投影。
 */
async function commitDoc(ctx: ToolCtx, doc: DocBrief, blocks: Block[], baseVersion: number | undefined): Promise<ToolResult> {
  const nextMd = blocksToMd(blocks);
  // 文档级硬上限（与 REST 10MB 同口径；批级 100KB 已在上游按入参口径先行拦截）
  if (Buffer.byteLength(nextMd, "utf8") > MCP_LIMITS.DOC_CANVAS_MAX_BYTES) {
    return deny("INVALID_PARAMS", `写入后正文超过 ${MCP_LIMITS.DOC_CANVAS_MAX_BYTES} 字节上限`);
  }
  const searchText = buildSearchText(doc.kind, nextMd);
  try {
    const result = await withWriteTx("doc.content.save", (tx) =>
      saveDocContentTx(tx, {
        docId: doc.id,
        kind: doc.kind,
        currentVersion: doc.contentVersion,
        content: nextMd,
        searchText,
        userId: ctx.subject.userId,
        baseVersion,
      }),
    );
    const canRead = await ctx.port!.can("r", { kind: "doc", id: doc.id });
    return text(JSON.stringify(canRead ? { ok: true, contentVersion: result.contentVersion } : { ok: true }));
  } catch (e) {
    if (e instanceof VersionConflictError) {
      // 乐观锁冲突：协议错误不走 HTTP 4xx（HTTP 200 + isError）；携带 currentVersion 供重读后重试
      return {
        content: [{ type: "text", text: JSON.stringify({ code: "VERSION_CONFLICT", message: e.message, currentVersion: e.currentVersion }) }],
        isError: true,
      };
    }
    throw e;
  }
}

/**
 * range 安全截断（0-based 闭区间 [start,end]，**绝不抛错**——只读工具对越界 range 宽容）。
 * 未提供 range -> 全量；越界收敛并标记 truncated。
 */
function resolveRange(raw: unknown, total: number): { start: number; end: number; truncated: boolean } {
  if (!raw || typeof raw !== "object") return { start: 0, end: total - 1, truncated: false };
  const r = raw as { start?: number; end?: number };
  const reqStart = typeof r.start === "number" ? r.start : 0;
  const reqEnd = typeof r.end === "number" ? r.end : total - 1;
  const start = Math.min(Math.max(reqStart, 0), Math.max(total - 1, 0));
  const end = Math.min(Math.max(reqEnd, start - 1), total - 1);
  return { start, end, truncated: start !== reqStart || end !== reqEnd };
}

/** doc.get_doc_blocks：读文档块。format=blocks -> mdToBlocks（带 seq）；format=markdown -> 原始正文直出。 */
export async function docGetDocBlocks(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const docId = String(args.docId ?? "");
  const g = await guardDoc(ctx, docId, "r");
  if ("denied" in g) return g.denied;
  const doc = g.doc;
  const format = args.format === "markdown" ? "markdown" : "blocks";
  if (format === "markdown") {
    return text(
      JSON.stringify({ docId: doc.id, kind: doc.kind, title: doc.title, contentVersion: doc.contentVersion, format, markdown: doc.content }),
    );
  }
  const all = withStableIds(mdToBlocks(doc.content));
  const total = all.length;
  const { start, end, truncated } = resolveRange(args.range, total);
  const blocks = all.slice(start, end + 1).map((b, i) => ({ seq: start + i, ...b }));
  return text(
    JSON.stringify({ docId: doc.id, kind: doc.kind, title: doc.title, contentVersion: doc.contentVersion, format, total, truncated, blocks }),
  );
}

/**
 * 剥掉 type（已作为 newBlock 首参），其余字段透传给 newBlock；id 不在入参 shape 内（服务端生成）。
 *
 * ⚠ 依赖耦合（勿破坏）：`newBlock` 的实现是 `{ id: uid(), type, ...partial }`，`...partial` 在尾位会**覆盖**
 * 服务端生成的 id。本函数因此**只对已通过 `blockOpShape` 校验的 op 调用**：该 shape 无 `id` 键且 zod4 默认
 * **丢弃**未知键，故 id 不可能进入 rest。**若将来把 `blockOpShape` 改成 looseObject/passthrough，此不变式即破**
 * （详见 schemas.ts 中 blockOpShape 的守卫注释）。
 * 影响面说明：`blocksToMd` 不序列化 id，故即便覆盖也不会污染落库正文——真正需要守住的是"AI 决定块 id"这一
 * 语义口径（M6 计划 §402 明令禁止），故不为它加运行期防线，而是把约束钉在 shape 定义处。
 */
function blockPartialOf(op: Record<string, unknown>): Partial<Block> {
  const { type: _t, ...rest } = op;
  return rest as Partial<Block>;
}

/** doc.append_blocks：闸门二 enforce u；在 afterBlockId 后（缺省末尾）插入若干块；单事务一次 version+1。 */
export async function docAppendBlocks(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const docId = String(args.docId ?? "");
  const g = await guardDoc(ctx, docId, "u");
  if ("denied" in g) return g.denied;
  const doc = g.doc;
  const ops = (args.ops ?? []) as Array<Record<string, unknown>>;
  // 缺省（未携带）-> undefined（last-write-wins，与 REST 同口径）。**绝不可用 Number(undefined)**
  // ——那得 NaN，而 saveDocContentTx 判 `baseVersion !== undefined`，NaN 会误入条件更新分支恒冲突。
  const baseVersion = typeof args.baseVersion === "number" ? args.baseVersion : undefined;
  // 批文本上限（100KB，UTF-8 口径服务端实测——zod 的 max 只按字符数）
  if (collectBytes(ops) > MCP_LIMITS.WRITE_TEXT_MAX_BYTES) {
    return deny("INVALID_PARAMS", `批文本超过 ${MCP_LIMITS.WRITE_TEXT_MAX_BYTES} 字节上限`);
  }
  const all = withStableIds(mdToBlocks(doc.content));
  let insertAt = all.length;
  const afterBlockId = args.afterBlockId === undefined || args.afterBlockId === null ? undefined : String(args.afterBlockId);
  if (afterBlockId !== undefined) {
    const idx = all.findIndex((b) => b.id === afterBlockId);
    if (idx < 0) return deny("INVALID_PARAMS", `afterBlockId 不存在：${afterBlockId}`);
    insertAt = idx + 1;
  }
  // AI 不得自带 id：newBlock 服务端生成，仅透传已校验的块属性
  const created = ops.map((op) => newBlock(op.type as BlockType, blockPartialOf(op)));
  const next = [...all.slice(0, insertAt), ...created, ...all.slice(insertAt)];
  return commitDoc(ctx, doc, next, baseVersion);
}

/** doc.update_block：闸门二 enforce u；patch 仅 text/checked/align（align 经注释通道）；块不存在整单拒。 */
export async function docUpdateBlock(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const docId = String(args.docId ?? "");
  const g = await guardDoc(ctx, docId, "u");
  if ("denied" in g) return g.denied;
  const doc = g.doc;
  const blockId = String(args.blockId ?? "");
  const patch = (args.patch ?? {}) as { text?: unknown; checked?: unknown; align?: unknown };
  // 空 patch 直接拒绝：否则会白白 contentVersion+1 并发一条 outbox upsert（触发无谓重索引）
  if (Object.keys(patch).length === 0) return deny("INVALID_PARAMS", "patch 至少需包含一项（text/checked/align）");
  // 缺省（未携带）-> undefined（last-write-wins，与 REST 同口径）。**绝不可用 Number(undefined)**
  // ——那得 NaN，而 saveDocContentTx 判 `baseVersion !== undefined`，NaN 会误入条件更新分支恒冲突。
  const baseVersion = typeof args.baseVersion === "number" ? args.baseVersion : undefined;
  if (collectBytes(patch) > MCP_LIMITS.WRITE_TEXT_MAX_BYTES) {
    return deny("INVALID_PARAMS", `批文本超过 ${MCP_LIMITS.WRITE_TEXT_MAX_BYTES} 字节上限`);
  }
  const all = withStableIds(mdToBlocks(doc.content));
  const idx = all.findIndex((b) => b.id === blockId);
  if (idx < 0) return deny("INVALID_PARAMS", `blockId 不存在：${blockId}`);
  const updated: Block = { ...all[idx]! };
  if (patch.text !== undefined) updated.text = String(patch.text);
  if (patch.checked !== undefined) updated.checked = Boolean(patch.checked);
  // align 只走注释通道：写 Block.align，由 blocksToMd 序列化为 <!-- align:x -->（绝不手写 md）
  if (patch.align !== undefined) updated.align = patch.align as Block["align"];
  const next = all.slice();
  next[idx] = updated;
  return commitDoc(ctx, doc, next, baseVersion);
}

/** doc.delete_blocks：闸门二 enforce u；原子批删（任一 id 不存在整批失败，无半应用）；confirm 由 zod4 literal 强制。 */
export async function docDeleteBlocks(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const docId = String(args.docId ?? "");
  const g = await guardDoc(ctx, docId, "u");
  if ("denied" in g) return g.denied;
  const doc = g.doc;
  const blockIds = (args.blockIds ?? []) as string[];
  // 缺省（未携带）-> undefined（last-write-wins，与 REST 同口径）。**绝不可用 Number(undefined)**
  // ——那得 NaN，而 saveDocContentTx 判 `baseVersion !== undefined`，NaN 会误入条件更新分支恒冲突。
  const baseVersion = typeof args.baseVersion === "number" ? args.baseVersion : undefined;
  const all = withStableIds(mdToBlocks(doc.content));
  const present = new Set(all.map((b) => b.id));
  const missing = blockIds.filter((id) => !present.has(id));
  // 原子批：任一 blockId 不存在 -> 整批失败（不静默忽略、不半应用）
  if (missing.length > 0) return deny("INVALID_PARAMS", `blockIds 不存在：${missing.join(", ")}`);
  const remove = new Set(blockIds);
  const next = all.filter((b) => !remove.has(b.id));
  return commitDoc(ctx, doc, next, baseVersion);
}
