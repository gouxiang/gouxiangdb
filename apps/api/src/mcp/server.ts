// M6/S2-S3 buildServer：每请求按身份构建 McpServer（**无会话信任**，§3-4）。
//
// 闸门一在 registerTools 内落地（PAT scope 粗筛 + M4 族可见集非空 -> 决定注册哪些工具）。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../version.js";
import type { McpSubject } from "./permissions/types.js";
import { registerTools, type ToolDeps } from "./tools/registry.js";

/** 服务器标识（initialize 回参）。 */
export const MCP_SERVER_INFO = { name: "gouxiangdb-mcp", version: VERSION } as const;

/** 为一请求构建 server 并按身份注册工具（未注册的工具对客户端不存在）。 */
export async function buildServer(subject: McpSubject, deps: ToolDeps = {}): Promise<McpServer> {
  const server = new McpServer({ ...MCP_SERVER_INFO });
  await registerTools(server, subject, deps);
  return server;
}
