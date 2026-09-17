// M6/S3 工具目录（唯一真源）：元数据（名称/scope/资源族/只读）+ zod4 入参 shape + handler。
//
// 闸门一在 registry 依本目录过滤：PAT scope 粗筛（无 record:write 则写工具不入册）+ 族可见集非空。
// S3 目录仅两件：连接性自检 ping_echo、最小资源工具 table.list_bases；S4 起按 §4.5 增补。

import { config } from "../../config.js";
import { tableGetSchema, tableListBases } from "./table.tools.js";
import { recordDeleteRecord, recordListRecords, recordQueryRecords, recordSearch } from "./record.tools.js";
import { deleteRecordShape, getSchemaShape, listBasesShape, listRecordsShape, pingEchoShape, queryRecordsShape, recordSearchShape } from "./schemas.js";
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
];
