// M6/S2-S3 buildServer：每请求按身份构建 McpServer（**无会话信任**，§3-4）。
//
// 闸门一在 registerTools 内落地（PAT scope 粗筛 + M4 族可见集非空 -> 决定注册哪些工具）。
// M6/S6：三份语言说明书注册为 MCP Resources（对任何已认证主体可读，不挂 scope 门）；
//   **HTTP 与 stdio 两条入口共用本 buildServer**，Resource/工具注册只有这一处。

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "../version.js";
import type { McpSubject } from "./permissions/types.js";
import { MANUAL_RESOURCES } from "./tools/manuals.js";
import { registerTools, type ToolDeps } from "./tools/registry.js";

/** 服务器标识（initialize 回参）。 */
export const MCP_SERVER_INFO = { name: "gouxiangdb-mcp", version: VERSION } as const;

/** 注册三份语言说明书为 MCP Resources（静态 markdown；不涉任何业务数据，故不挂 scope 门）。 */
function registerManualResources(server: McpServer): void {
  for (const m of MANUAL_RESOURCES) {
    server.registerResource(m.name, m.uri, { mimeType: m.mimeType }, () => ({
      contents: [{ uri: m.uri, mimeType: m.mimeType, text: m.text }],
    }));
  }
}

/** 为一请求构建 server：先注册 Resources（与身份无关），再按身份注册工具（未注册的工具对客户端不存在）。 */
export async function buildServer(subject: McpSubject, deps: ToolDeps = {}): Promise<McpServer> {
  const server = new McpServer({ ...MCP_SERVER_INFO });
  registerManualResources(server);
  await registerTools(server, subject, deps);
  return server;
}
