// M6/S3 工具目录（唯一真源）：元数据（名称/scope/资源族/只读）+ zod4 入参 shape + handler。
//
// 闸门一在 registry 依本目录过滤：PAT scope 粗筛（无 record:write 则写工具不入册）+ 族可见集非空。
// S3 目录仅两件：连接性自检 ping_echo、最小资源工具 table.list_bases；S4 起按 §4.5 增补。

import { config } from "../../config.js";
import { tableGetSchema, tableListBases } from "./table.tools.js";
import { recordCreateRecord, recordDeleteRecord, recordUpdateRecord, recordListRecords, recordQueryRecords, recordSearch } from "./record.tools.js";
import { canvasGetBoard } from "./canvas.tools.js";
import { canvasCommitElements } from "./canvasWrite.tools.js";
import { docAppendBlocks, docDeleteBlocks, docGetDocBlocks, docUpdateBlock } from "./doc.tools.js";
import { appendBlocksShape, commitElementsShape, createRecordShape, deleteBlocksShape, deleteRecordShape, updateBlockShape, updateRecordShape, getBoardShape, getDocBlocksShape, getSchemaShape, listBasesShape, listRecordsShape, pingEchoShape, queryRecordsShape, recordSearchShape } from "./schemas.js";
import { text, type ToolSpec } from "./types.js";

export const TOOL_CATALOG: readonly ToolSpec[] = [
  {
    meta: {
      name: "ping_echo",
      title: "ping_echo",
      description: "连通性自检：原样回显 text（不涉资源，对所有已认证主体可见）。",
      scopes: [],
      family: null,
      readOnly: true,
    },
    inputShape: pingEchoShape,
    run: async (_ctx, args) => text(`pong:${String(args.text ?? "")}`),
  },
  {
    meta: {
      name: "table.list_bases",
      title: "列出可见基础库",
      description: "列出该令牌主体可见的 base id（经 M4 可见集与逐 base 复核）。",
      scopes: ["record:read"],
      family: "table",
      readOnly: true,
    },
    inputShape: listBasesShape,
    run: tableListBases,
  },
  {
    meta: {
      name: "table.get_schema", title: "读取表结构",
      description: "返回该 base 下可见表与可见字段的元数据（不可见字段不出现在 schema 中）。",
      scopes: ["record:read"], family: "table", readOnly: true,
    },
    inputShape: getSchemaShape,
    run: tableGetSchema,
  },
  {
    meta: {
      name: "record.list_records", title: "列出记录",
      description: "按 keyset 游标分页读取表内记录（limit≤200；不可见字段物理缺席）。",
      scopes: ["record:read"], family: "table", readOnly: true,
    },
    inputShape: listRecordsShape,
    run: recordListRecords,
  },
  {
    meta: {
      name: "record.query_records", title: "查询记录",
      description: "带受控 filter/sort 的 keyset 查询（算子白名单；禁公式与裸 SQL）。",
      scopes: ["record:read"], family: "table", readOnly: true,
    },
    inputShape: queryRecordsShape,
    run: recordQueryRecords,
  },
  {
    meta: {
      name: "record.create_record", title: "创建记录",
      description: "在指定表创建一条记录（需 confirm=true；字段映射逐列受字段级写权约束）。",
      scopes: ["record:write"], family: "table", actions: ["c"], readOnly: false,
    },
    inputShape: createRecordShape,
    run: recordCreateRecord,
  },
  {
    meta: {
      name: "record.update_record", title: "更新记录",
      description: "更新一条记录的字段（字段级写权约束；不可见字段整单拒绝）。",
      scopes: ["record:write"], family: "table", actions: ["u"], readOnly: false,
    },
    inputShape: updateRecordShape,
    run: recordUpdateRecord,
  },
  {
    meta: {
      name: "record.delete_record", title: "删除记录",
      description: "软删一条记录（需 confirm=true；与 REST DELETE 同语义，可由回收站恢复）。",
      scopes: ["record:write"], family: "table", actions: ["d"], readOnly: false,
    },
    inputShape: deleteRecordShape,
    run: recordDeleteRecord,
  },
  {
    meta: {
      name: "record.search", title: "统一检索",
      description: "薄封装 M5 统一检索（关键词/向量混合；scope 先收敛由 M5 保证）。",
      scopes: ["record:read"], family: null, readOnly: true,
      available: () => config.m5Search !== "off",
    },
    inputShape: recordSearchShape,
    run: recordSearch,
  },
  {
    meta: {
      name: "doc.get_doc_blocks", title: "读取文档块",
      description: "读取文档的结构化块（format=blocks 经共享块模型解析）或原始 Markdown；range 按块序号 0-based 闭区间切片。",
      scopes: ["doc:read"], family: "doc", readOnly: true,
    },
    inputShape: getDocBlocksShape,
    run: docGetDocBlocks,
  },
  {
    meta: {
      name: "doc.append_blocks", title: "追加文档块",
      description: "在指定块之后（缺省末尾）追加块；块 id 由服务端生成，单事务一次内容版本递增（需 baseVersion 乐观锁）。",
      scopes: ["doc:write"], family: "doc", actions: ["u"], readOnly: false,
    },
    inputShape: appendBlocksShape,
    run: docAppendBlocks,
  },
  {
    meta: {
      name: "doc.update_block", title: "更新文档块",
      description: "更新单个块的 text/checked/align（对齐经注释通道持久化；块不存在则整单拒绝，需 baseVersion）。",
      scopes: ["doc:write"], family: "doc", actions: ["u"], readOnly: false,
    },
    inputShape: updateBlockShape,
    run: docUpdateBlock,
  },
  {
    meta: {
      name: "doc.delete_blocks", title: "删除文档块",
      description: "原子批删若干块（任一 id 不存在则整批失败，无半应用；需 confirm=true 与 baseVersion）。",
      scopes: ["doc:write"], family: "doc", actions: ["u"], readOnly: false,
    },
    inputShape: deleteBlocksShape,
    run: docDeleteBlocks,
  },
  {
    meta: {
      name: "canvas.get_board", title: "读取画布",
      description: "只读读取画布元素与内容版本（元素原样返回，未知键不剥离；画布写入见 canvas.commit_elements）。",
      scopes: ["canvas:read"], family: "canvas", actions: ["r"], readOnly: true,
    },
    inputShape: getBoardShape,
    run: canvasGetBoard,
  },
  {
    meta: {
      name: "canvas.commit_elements", title: "写入画布图元",
      description: "在画布末尾追加图元（当前最小集仅 op element.create 创建 geometry/rectangle；服务端生成 id、尾插、单事务版本+1）。"
        + "其它操作名/箭头/关联块整批拒绝 UNSUPPORTED_OPERATION；需 confirm=true 与 baseVersion 乐观锁（缺省=last-write-wins）。",
      scopes: ["canvas:write"], family: "canvas", actions: ["u"], readOnly: false,
    },
    inputShape: commitElementsShape,
    run: canvasCommitElements,
  },
];
