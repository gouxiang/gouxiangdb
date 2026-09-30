// M6/S3 工具目录（唯一真源）：元数据（名称/资源族/只读）+ zod4 入参 shape + handler。
//
// 闸门一在 registry 依本目录过滤：运行期可用性门（available）+ 族可见集非空。
// meta.scopes 是 P3 前的历史字段（PAT scope 粗筛），**已不参与判定**——能力按签发者用户实时计算；
// 保留它是为了让目录仍可读地描述"这件工具历史上属于哪个族"，且老数据/审计口径不受影响。
// S3 目录仅两件：连接性自检 ping_echo、最小资源工具 table.list_bases；S4 起按 §4.5 增补。

import { isUnifiedSearchEnabled } from "../../domain/search/searchGateRuntime.js";
import { tableGetSchema, tableListBases } from "./table.tools.js";
import { tableCreateTable, tableUpdateTable, tableDeleteTable } from "./tableBuild.tools.js";
import { fieldCreateField, fieldUpdateField, fieldDeleteField } from "./fieldBuild.tools.js";
import { recordCreateRecord, recordDeleteRecord, recordUpdateRecord, recordListRecords, recordQueryRecords, recordSearch } from "./record.tools.js";
import { canvasGetBoard } from "./canvas.tools.js";
import { canvasCommitElements } from "./canvasWrite.tools.js";
import { docAppendBlocks, docDeleteBlocks, docGetDocBlocks, docUpdateBlock } from "./doc.tools.js";
import {
  appendBlocksShape, commitElementsShape, createRecordShape, deleteBlocksShape,
  deleteRecordShape, updateBlockShape, updateRecordShape, getBoardShape,
  getDocBlocksShape, getSchemaShape, listBasesShape, listRecordsShape,
  pingEchoShape, queryRecordsShape, recordSearchShape,
} from "./schemas.js";
import {
  createTableShape, updateTableShape, deleteTableShape,
  createFieldShape, updateFieldShape, deleteFieldShape,
} from "./buildSchemas.js";
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
      description: "返回该 base 下可见表与可见字段的元数据（不可见字段不出现在 schema 中）；"
        + "单选型/多选型字段附 options:[{id,name,color}]，用于把记录里的选项 id 映射成可读名称。",
      scopes: ["record:read"], family: "table", readOnly: true,
    },
    inputShape: getSchemaShape,
    run: tableGetSchema,
  },
  {
    meta: {
      name: "table.create_table", title: "创建数据表",
      description: "在指定 base 下创建一张表（含「名称」主字段与默认网格视图；需 confirm=true）。",
      scopes: ["record:write"], family: "table", actions: ["manage_schema"], readOnly: false,
    },
    inputShape: createTableShape,
    run: tableCreateTable,
  },
  {
    meta: {
      name: "table.update_table", title: "更新数据表",
      description: "修改表名/主字段/图标与图标颜色（仅传 name 时改名；同库表名唯一）。",
      scopes: ["record:write"], family: "table", actions: ["manage_table"], readOnly: false,
    },
    inputShape: updateTableShape,
    run: tableUpdateTable,
  },
  {
    meta: {
      name: "table.delete_table", title: "删除数据表",
      description: "软删整张表（级联记录/字段；需 confirm=true；可由回收站恢复）。",
      scopes: ["record:write"], family: "table", actions: ["manage_table"], readOnly: false,
    },
    inputShape: deleteTableShape,
    run: tableDeleteTable,
  },
  {
    meta: {
      name: "field.create_field", title: "创建字段",
      description: "在指定表创建字段（含关联字段双向对；类型配置经服务端校验；需 confirm=true）。",
      scopes: ["record:write"], family: "table", actions: ["manage_schema"], readOnly: false,
    },
    inputShape: createFieldShape,
    run: fieldCreateField,
  },
  {
    meta: {
      name: "field.update_field", title: "更新字段",
      description: "更新字段配置（部分提交；关联字段改名/改关系会同步反向字段）。",
      scopes: ["record:write"], family: "table", actions: ["manage_schema"], readOnly: false,
    },
    inputShape: updateFieldShape,
    run: fieldUpdateField,
  },
  {
    meta: {
      name: "field.delete_field", title: "删除字段",
      description: "软删字段（关联字段对称删反向字段；级联 lookup/rollup/count；需 confirm=true）。",
      scopes: ["record:write"], family: "table", actions: ["manage_schema"], readOnly: false,
    },
    inputShape: deleteFieldShape,
    run: fieldDeleteField,
  },
  {
    meta: {
      name: "record.list_records", title: "列出记录",
      description: "按 keyset 游标分页读取表内记录（limit≤200；不可见字段物理缺席）。"
        + "单选/多选字段在 fields 里的值是选项 id（回写请仍用 id）；可读名称见同一条记录的 fieldsDisplay"
        + "（表内无选择类字段时不返回该键）与 table.get_schema 的 options。",
      scopes: ["record:read"], family: "table", readOnly: true,
    },
    inputShape: listRecordsShape,
    run: recordListRecords,
  },
  {
    meta: {
      name: "record.query_records", title: "查询记录",
      description: "带受控 filter/sort 的 keyset 查询（算子白名单；禁公式与裸 SQL）。"
        + "过滤/排序值用选项 id；读出的选项名见同一条记录的 fieldsDisplay（无选择类字段时不返回该键）。",
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
      // 可用性门走总门判定（db 覆盖优先于 env），不再硬编码 config.m5Search。
      // 委托 domain 封装层：本目录不碰 prisma，判定真源仍是 searchGate.resolveSearchGate。
      scopes: ["record:read"], family: null, readOnly: true,
      available: () => isUnifiedSearchEnabled(),
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
