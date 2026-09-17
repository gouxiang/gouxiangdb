// M6/S3 工具目录（唯一真源）：元数据（名称/scope/资源族/只读）+ zod4 入参 shape + handler。
//
// 闸门一在 registry 依本目录过滤：PAT scope 粗筛（无 record:write 则写工具不入册）+ 族可见集非空。
// S3 目录仅两件：连接性自检 ping_echo、最小资源工具 table.list_bases；S4 起按 §4.5 增补。

import { tableListBases } from "./table.tools.js";
import { listBasesShape, pingEchoShape } from "./schemas.js";
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
];
