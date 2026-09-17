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
//
// M6/S7：本层承担两件信封之外的事——
//   ① 把真实来源（ip / 有效路径 / 方法）注入 ToolDeps，供调用审计使用；
//   ② **UNKNOWN_TOOL 补记**：未注册工具被直调时 SDK 在调用回调前就拒（不经过 tools/registry 信封），
//      故必须在请求体层预读 tools/call 的 tool 名，与"实际注册集"比对，对未注册者补一条审计
//      （计划 §409 明令：tool 未知时也要能记下客户端传来的 tool 名与 patId）。

import type { Context } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "../server.js";
import { emitToolCall } from "../audit.js";
import { mcpPermissionPortFactory } from "../permissions/m4Adapter.js";
import { effectivePath } from "../../utils/request-path.js";
import { sourceIp } from "../../utils/client-ip.js";
import type { ToolDeps } from "../tools/registry.js";
import type { McpSubject } from "./authenticate.js";

/** 预读结果：单个/批量 JSON-RPC 里的 tools/call 调用（tool 名 + 入参）。 */
interface PeekedCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * 预读请求体里的 tools/call（不改动原请求：clone 后解析）。
 * 任何解析异常一律返回空数组——预读只为补记审计，**绝不影响**正常协议处理。
 */
async function peekToolCalls(raw: Request): Promise<PeekedCall[]> {
  try {
    const body = (await raw.clone().json()) as unknown;
    const msgs = Array.isArray(body) ? body : [body];
    const out: PeekedCall[] = [];
    for (const m of msgs) {
      if (!m || typeof m !== "object") continue;
      const msg = m as { method?: unknown; params?: unknown };
      if (msg.method !== "tools/call" || !msg.params || typeof msg.params !== "object") continue;
      const p = msg.params as { name?: unknown; arguments?: unknown };
      if (typeof p.name !== "string") continue;
      out.push({ name: p.name, args: p.arguments && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : {} });
    }
    return out;
  } catch {
    return [];
  }
}

export async function handleMcpRequest(c: Context, subject: McpSubject): Promise<Response> {
  // 审计来源：真实 ip + 去网关前缀的有效路径（带 basePath 部署下也记逻辑路径）。
  const auditCtx = { ip: sourceIp(c), path: effectivePath(c), method: c.req.method };
  // 捕获实际注册的工具名（闸门一决策的唯一产物），用于 UNKNOWN_TOOL 审计判定。
  const registered = new Set<string>();
  // 每请求新建权限端口（内部惰性预取一次 scope 并复用）；接真 M4，无测试替身。
  const deps: ToolDeps = {
    port: mcpPermissionPortFactory(subject),
    audit: auditCtx,
    onRegistered: (names) => names.forEach((n) => registered.add(n)),
  };
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // 无状态：无 Session-Id
    enableJsonResponse: true, // 协议请求 -> 完整 JSON 响应（SSE 不开）
  });
  // 预读必须在 handleRequest 之前（body 只能被消费一次；clone 分支供解析）。
  const peeked = await peekToolCalls(c.req.raw);
  const server = await buildServer(subject, deps);
  await server.connect(transport); // 铁律：不 connect 必挂死

  const response = await transport.handleRequest(c.req.raw);

  // UNKNOWN_TOOL 补记：未注册工具由 SDK 直接拒（-32602），信封拿不到控制权。
  // 已注册工具由此处跳过（其审计由 registry 信封在 handler 收尾时记），故不会重复审计。
  for (const call of peeked) {
    if (registered.has(call.name)) continue;
    emitToolCall({
      ctx: auditCtx,
      actorId: subject.userId,
      patId: subject.patId,
      tool: call.name,
      resultCode: "UNKNOWN_TOOL",
      args: call.args,
    });
  }

  // 响应已完整生成（JSON 模式），此时清理不会截断；用微任务确保先交回 Hono。
  queueMicrotask(() => {
    void transport.close().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
  return response;
}
