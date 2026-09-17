// M6/S2 buildServer：每请求按身份构建一个 McpServer（**无会话信任**，§3-4）。
//
// 闸门一（工具可见性）在 S3 落地：本文件只负责组装 + 委托 registerTools；
// S3 会在 registerTools 内按 M4 可见集/字段能力决定注册哪些工具与 schema 收窄。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../version.js";
import type { McpSubject } from "./transport/authenticate.js";
import { registerTools, type ToolDeps } from "./tools/registry.js";

/** 服务器标识（initialize 回参）。 */
export const MCP_SERVER_INFO = { name: "gouxiangdb-mcp", version: VERSION } as const;

/** 为一请求构建 server 并按身份注册工具（未注册的工具对客户端不存在）。 */
export function buildServer(subject: McpSubject, deps: ToolDeps = {}): McpServer {
  const server = new McpServer({ ...MCP_SERVER_INFO });
  registerTools(server, subject, deps);
  return server;
}
