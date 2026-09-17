// M6/S2 工具 JSON Schema 唯一真源（**全仓唯一允许 import zod4 的文件**，见计划 §4.2 zod4 隔离纪律）。
//
// zod4 来源：@modelcontextprotocol/sdk@1.30.0 的 peer `zod ^3.25 || ^4.0` 由仓内 zod 3.25.76 满足，
// 其 `zod/v4` 子路径即 zod4 实现（SDK 自身 15 处 `from 'zod/v4'`）。业务层继续用 zod3（`from "zod"`），
// 两者不得混用；S2 起由 `__tests__/zod4-isolation.test.ts` 与 CI grep 守卫「zod/v4 未扩散出本文件」。
//
// 上限常量（§3-8 配额契约）亦单点定义，供工具与 openapi 对拍复用。

import { z } from "zod/v4";
import type { BlockType } from "@gx/blocks";

/** 配额常量（§3-8）：读 limit ≤200、写批量 op ≤100、批文本 ≤100KB、文档/画布 10MB。 */
export const MCP_LIMITS = {
  READ_LIMIT_MAX: 200,
  WRITE_OPS_MAX: 100,
  WRITE_TEXT_MAX_BYTES: 100 * 1024,
  DOC_CANVAS_MAX_BYTES: 10 * 1024 * 1024,
} as const;

/** 连接性自检工具 ping_echo 入参。 */
export const pingEchoShape = {
  text: z.string().max(200).describe("回显文本（≤200 字符）"),
};

/** table.list_bases：无入参。 */
export const listBasesShape = {};

/** 读工具共用的 limit（§3-8 配额：≤200；超限由 SDK 入参校验直接返 -32602）。 */
const LIMIT_MAX = MCP_LIMITS.READ_LIMIT_MAX;

/** 受控 filter 算子白名单（§4.5：禁任意 SQL/公式；非法算子由 zod4 enum 拦为 -32602）。 */
export const FILTER_OPS = [
  "is", "isNot", "contains", "notContains", "isEmpty", "isNotEmpty",
  "gte", "lte", "gt", "lt", "isAnyOf", "checked", "notChecked",
] as const;

const filterNode = z.object({
  fieldId: z.string().min(1),
  op: z.enum(FILTER_OPS),
  value: z.string().optional(),
});

export const getSchemaShape = {
  baseId: z.string().min(1).describe("基础库 id（须在该令牌可见集内）"),
};

export const listRecordsShape = {
  tableId: z.string().min(1),
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(LIMIT_MAX).optional(),
  search: z.string().max(200).optional(),
};

export const queryRecordsShape = {
  tableId: z.string().min(1),
  filter: z.array(filterNode).max(20).optional(),
  sortFieldId: z.string().min(1).optional(),
  sortDirection: z.enum(["asc", "desc"]).optional(),
  cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(LIMIT_MAX).optional(),
};

export const recordSearchShape = {
  q: z.string().min(1).max(200),
  // 与 M5 实际 RequestedMode 对齐（计划写 "like" 已过期；M5 为 auto|fts|vector）
  mode: z.enum(["auto", "fts", "vector"]).optional(),
  limit: z.number().int().min(1).max(LIMIT_MAX).optional(),
};

/** record.delete_record：**confirm 必须是字面量 true**（缺省/false 由 SDK 入参校验拦为 -32602）。 */
export const deleteRecordShape = {
  tableId: z.string().min(1),
  recordId: z.string().min(1),
  confirm: z.literal(true).describe("删除确认；必须是字面量 true（破坏性操作强制显式确认）"),
};

/** record.create_record：fields 为 {fieldId: value}；confirm 必须字面量 true。 */
export const createRecordShape = {
  tableId: z.string().min(1),
  fields: z.record(z.string(), z.unknown()).describe("字段映射 {fieldId: value}"),
  confirm: z.literal(true).describe("写入确认；必须是字面量 true"),
};

/** record.update_record：fields 为 {fieldId: value}（仅含要改的键）。 */
export const updateRecordShape = {
  tableId: z.string().min(1),
  recordId: z.string().min(1),
  fields: z.record(z.string(), z.unknown()).describe("要更新的字段映射 {fieldId: value}"),
};

/* ------------------------- M6/S5 doc 族（文档块语言） ------------------------- */

/**
 * 可写入的块类型白名单（与 @gx/blocks 的 `BlockType` 同域）。
 * 完备性由下方编译期守卫保证：@gx/blocks 新增块类型而此处未同步时 tsc 直接报错。
 */
export const BLOCK_TYPES = [
  "p",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "task",
  "quote",
  "callout",
  "toggle",
  "code",
  "hr",
  "pagebreak",
  "table",
  "image",
  "video",
  "audio",
  "pdf",
  "attachment",
  "math",
  "raw",
] as const;

// 编译期完备性守卫：_MissingBlockType 非 never 时本行赋值类型不匹配 -> tsc 报错。
type _MissingBlockType = Exclude<BlockType, (typeof BLOCK_TYPES)[number]>;
const _assertBlockTypesComplete: [_MissingBlockType] extends [never] ? true : false = true;
void _assertBlockTypesComplete;

/**
 * 单个「块操作」入参（append_blocks 之 ops 元素）。
 * **刻意不含 `id`**：块 id 由服务端 `newBlock` 生成，AI 不得自带插入 id（严禁凭空指定/覆盖块 id）。
 *
 * ⚠ 守卫（勿改成 looseObject / passthrough / strictObject 语义变更）：
 *   `z.object` 默认**丢弃**未知键（已实测：`blockOpShape.parse({type:"p",id:"evil"})` 结果无 `id` 键），
 *   这正是"AI 不得自带 id"的实现依据——下游 `doc.tools.ts:blockPartialOf` 把 op 余下字段直接透传给
 *   `newBlock`（其实现为 `{ id: uid(), type, ...partial }`，`...partial` 在尾位**会覆盖**服务端 id）。
 *   一旦本 shape 改为 looseObject/passthrough，未知键将透传，该不变式即破。
 *   回归护栏：`__tests__/m6-s5-doc-tools.test.ts` 有一例直接断言 parse 后无 `id` 键。
 */
export const blockOpShape = z.object({
  type: z.enum(BLOCK_TYPES).describe("块类型"),
  text: z.string().optional().describe("文本类块的行内 Markdown 源码"),
  checked: z.boolean().optional().describe("task 勾选态"),
  lang: z.string().optional().describe("code 语言"),
  code: z.string().optional().describe("code 代码内容"),
  rows: z.array(z.array(z.string())).optional().describe("table 二维数组（第 0 行为表头）"),
  src: z.string().optional().describe("媒体类资源地址"),
  alt: z.string().optional().describe("image alt / pdf 标题 / 媒体说明"),
  name: z.string().optional().describe("attachment 文件名"),
  variant: z.enum(["note", "tip", "warning", "important", "caution"]).optional().describe("callout 类型"),
  summary: z.string().optional().describe("toggle 折叠块标题"),
  formula: z.string().optional().describe("math 公式源码"),
  raw: z.string().optional().describe("raw 透传的原始 Markdown"),
  align: z.enum(["left", "center", "right"]).nullable().optional().describe("块级对齐（仅注释通道生效）"),
});

/** doc.get_doc_blocks：format=blocks 走 mdToBlocks；format=markdown 直出正文；range 按块 seq 0-based 闭区间切片。 */
export const getDocBlocksShape = {
  docId: z.string().min(1).describe("文档 id（须在该令牌可见集内）"),
  format: z.enum(["blocks", "markdown"]).describe("blocks=结构化块数组；markdown=原始 Markdown 正文"),
  range: z
    .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
    .optional()
    .describe("按块序号切片（0-based 闭区间 [start,end]；越界安全截断，不报错）"),
};

/**
 * doc 族三个写 shape 的 `baseVersion` **为可选**（两个理由，缺一不可）：
 *   1. 裁决 (b)「只写身份必须可用」：doc:write 而无 doc:read 的主体拿不到 get_doc_blocks，
 *      也就无从得知 contentVersion；若强制必填，等于逼用户为写入额外授予读权限，工具集成死工具集。
 *   2. 与 REST 契约一致：`saveDocContentTx` 的 `baseVersion?: number` 缺省即 last-write-wins
 *      （REST `PUT /docs/:docId/content`：「旧客户端未携带版本 -> 保持 last-write-wins，版本号照常递增」）。
 * 携带（陈旧）baseVersion 时仍走条件更新 -> 冲突回 VERSION_CONFLICT + currentVersion（乐观锁未被削弱）。
 */

/** doc.append_blocks：afterBlockId 缺省=末尾；ops ≤100；单事务一次 contentVersion+1；baseVersion 可选乐观锁。 */
export const appendBlocksShape = {
  docId: z.string().min(1),
  afterBlockId: z.string().min(1).optional().describe("在该块 id 之后插入（缺省=追加到文档末尾）"),
  ops: z.array(blockOpShape).min(1).max(MCP_LIMITS.WRITE_OPS_MAX).describe(`要追加的块操作（≤${MCP_LIMITS.WRITE_OPS_MAX}）`),
  baseVersion: z.number().int().min(0).optional().describe("读取时的 contentVersion（乐观锁）；缺省=last-write-wins，与 REST PUT /docs/:docId/content 同口径"),
};

/** doc.update_block：patch 仅 text/checked/align；align 仅走注释通道（写 Block.align，不手写 md）。 */
export const updateBlockShape = {
  docId: z.string().min(1),
  blockId: z.string().min(1).describe("目标块 id（须为当前文档内的块）"),
  patch: z
    .object({
      text: z.string().optional(),
      checked: z.boolean().optional(),
      align: z.enum(["left", "center", "right"]).nullable().optional(),
    })
    .describe("要修改的块属性（至少一项）"),
  baseVersion: z.number().int().min(0).optional().describe("读取时的 contentVersion（乐观锁）；缺省=last-write-wins，与 REST PUT /docs/:docId/content 同口径"),
};

/** doc.delete_blocks：原子批删（任一 id 不存在整批失败）；confirm 必须字面量 true。 */
export const deleteBlocksShape = {
  docId: z.string().min(1),
  blockIds: z.array(z.string().min(1)).min(1).max(MCP_LIMITS.WRITE_OPS_MAX).describe(`要删除的块 id（≤${MCP_LIMITS.WRITE_OPS_MAX}）`),
  baseVersion: z.number().int().min(0).optional().describe("读取时的 contentVersion（乐观锁）；缺省=last-write-wins，与 REST PUT /docs/:docId/content 同口径"),
  confirm: z.literal(true).describe("删除确认；必须是字面量 true（破坏性操作强制显式确认）"),
};

/* ------------------------- M6/S6 canvas 族（画布只读） ------------------------- */

/** canvas.get_board：画布只读（content=PlaitElement[] JSON；未知键透传不剥离）。 */
export const getBoardShape = {
  docId: z.string().min(1).describe("画布文档 id（须在该令牌可见集内）"),
};
