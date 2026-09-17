// M6/S2 Streamable HTTP 无状态直桥（每请求 new server + new transport）。
//
// 权威依据：M6-implementation-plan §4.1（③ return transport.handleRequest）+ spike-mcp-transport 实测陷阱：
//   1) **必须 await server.connect(transport)** —— 漏掉会永久挂起；
//   2) `handleRequest` **返回前不得 close**（会截断响应）——本实现在拿到完整 Response 后才异步清理；
//   3) **transport 严禁跨请求复用** —— 每请求 new（无状态 JSON 模式）；
//   4) Accept/Content-Type 协议校验**交给 SDK**（不自造 415/406）。
//
// 无状态模式：sessionIdGenerator 显式 undefined（不生成/不校验 Session-Id），enableJsonResponse=true
// 使 JSON-RPC 请求以单条完整 JSON 响应返回（不开 SSE 流），故无流式清理复杂度。

import type { Context } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "../server.js";
import type { ToolDeps } from "../tools/registry.js";
import type { McpSubject } from "./authenticate.js";

export async function handleMcpRequest(c: Context, subject: McpSubject, deps: ToolDeps = {}): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // 无状态：无 Session-Id
    enableJsonResponse: true, // 协议请求 -> 完整 JSON 响应（SSE 不开）
  });
  const server = buildServer(subject, deps);
  await server.connect(transport); // 铁律：不 connect 必挂死

  const response = await transport.handleRequest(c.req.raw);

  // 响应已完整生成（JSON 模式），此时清理不会截断；用微任务确保先交回 Hono。
  queueMicrotask(() => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  return response;
}
