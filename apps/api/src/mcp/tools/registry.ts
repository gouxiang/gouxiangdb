// M6/S2 工具注册枢纽。
//
// S2 只注册冒烟工具 `ping_echo`（传输骨架验证用）；S3 起由闸门一（M4 可见集）驱动动态注册
// 真实工具族（table/record/doc/canvas），未通过闸门的工具**根本不注册**（直调即 UNKNOWN_TOOL）。
//
// 纪律（§3-3）：本文件与工具 handler 一律不 import 旧守卫（guards.ts）、不裸查 prisma 做资源授权；
// 资源判定经 M4 端口（S3）。zod4 仅从 ./schemas.js 引入。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpSubject } from "../transport/authenticate.js";
import { pingEchoShape } from "./schemas.js";

export interface ToolDeps {
  // S3 扩展点：McpPermissionPort（闸门一/二）与各 domain service 在此注入。
  readonly permissions?: unknown;
}

/** 注册该主体可见的工具。S2：仅 ping_echo。 */
export function registerTools(server: McpServer, subject: McpSubject, deps: ToolDeps): void {
  void subject;
  void deps;
  server.registerTool(
    "ping_echo",
    {
      title: "ping_echo",
      description: "连通性自检：原样回显 text（M6/S2 传输骨架冒烟工具）。",
      inputSchema: pingEchoShape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `pong:${text}` }] }),
  );
}
