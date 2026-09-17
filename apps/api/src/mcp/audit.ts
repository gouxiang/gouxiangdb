// M6/S7 MCP 调用审计发射器（transport 无关：HTTP 与 stdio 共用，不依赖 Hono Context）。
//
// 权威依据：M6-implementation-plan §409（每次 call 收尾必记；tool 未知时也要能记 tool 名与 patId）、
//           spike-mcp-transport §462（mcp_tool_call 字段建议）、§317（resultCode 词汇表）。
//
// 铁律（三件套）：
//   1. **字段白名单**：detail 只记 patId / tool / 资源 id / resultCode / requestId / durationMs /
//      白名单化的入参元信息；**绝不记 fields/ops/patch/element/content 等业务值**（防数据入日志）。
//   2. **token 绝不落盘**：认证失败只记 ip + 明文前缀（14 字符，不可认证，见 tokens.ts:16）+ reason。
//      writeAudit 内的 redactSecrets 是第二道网（键名含 token/secret/bearer 一律 [REDACTED]）。
//   3. **审计失败不阻断业务**：writeAudit 内已 catch IO 异常只告警（audit.ts:144-148），本层不再抛。

import { config } from "../config.js";
import { writeAudit } from "../audit/audit.js";

/** 调用来源（HTTP: 真实 ip/路径；stdio: 固定 "stdio"）。 */
export interface McpCallAuditCtx {
  ip: string;
  path: string;
  method: string;
}

/** stdio 入口的固定来源（stdio 无 HTTP 语义，用显式常量而非伪造 ip）。 */
export const STDIO_AUDIT_CTX: McpCallAuditCtx = { ip: "stdio", path: "stdio", method: "STDIO" };

/** 审计专用兜底来源（无上下文时；不应出现在正常路径）。 */
export const UNKNOWN_AUDIT_CTX: McpCallAuditCtx = { ip: "unknown", path: "", method: "" };

/**
 * resultCode -> 审计 status（§317 词汇表映射为语义化 HTTP 码，便于按 status 聚合告警）。
 * 注意：这是**审计行**里的 status，不是响应码——MCP 工具错误一律 HTTP 200（协议错误不走 4xx）。
 */
const CODE_STATUS: Record<string, number> = {
  OK: 200,
  UNKNOWN_TOOL: 404,
  UNSUPPORTED_OPERATION: 400,
  FORBIDDEN_RESOURCE: 403,
  FORBIDDEN_FIELD: 403,
  FORBIDDEN_GROUP: 403,
  VERSION_CONFLICT: 409,
  CONFIRM_REQUIRED: 400,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  INVALID_PARAMS: 400,
  IN_PROGRESS: 409,
  // 仅用于审计：适配层捕获到 handler 未预期异常（§317 词汇表描述的是"工具级"结果码）。
  INTERNAL_ERROR: 500,
};

export function auditStatusFor(resultCode: string): number {
  return CODE_STATUS[resultCode] ?? 200;
}

/** 资源 id 键（按具体度排序：record > doc > canvas > table > base）。 */
const RESOURCE_ID_KEYS = ["recordId", "docId", "canvasId", "tableId", "baseId"] as const;
/** 直接透传的标量元信息键（非业务值）。 */
const SCALAR_META_KEYS = ["limit", "baseVersion", "confirm", "mode", "afterBlockId", "blockId"] as const;

/** 工具族 -> 资源 kind（越权追溯用；record.* 归 table 族）。 */
function resourceKindOf(tool: string): string | null {
  const family = tool.split(".")[0];
  if (family === "table" || family === "record") return "table";
  if (family === "doc") return "doc";
  if (family === "canvas") return "canvas";
  return null;
}

/** 从入参提取主资源 {kind,id}（供越权追溯）；无资源 id 时返回 null（如 ping_echo / record.search）。 */
export function resourceOf(tool: string, args: Record<string, unknown>): { kind: string; id: string } | null {
  const kind = resourceKindOf(tool);
  if (!kind) return null;
  for (const k of RESOURCE_ID_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return { kind, id: v };
  }
  return null;
}

/**
 * 入参白名单化（**绝不透传业务值**）：仅保留资源 id 标量、分页/版本/确认等元信息，
 * cursor 只记存在性（游标是 opaque 串，无追溯价值且有长度风险）。
 */
export function sanitizeArgsForAudit(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [...RESOURCE_ID_KEYS, ...SCALAR_META_KEYS]) {
    const v = args[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  if (args.cursor !== undefined) out.hasCursor = true;
  if (args.requestId !== undefined) out.requestId = String(args.requestId);
  return out;
}

export interface ToolCallAuditInput {
  ctx: McpCallAuditCtx;
  actorId: string;
  patId: string;
  tool: string;
  /** §317 词汇（OK / FORBIDDEN_RESOURCE / UNKNOWN_TOOL / TIMEOUT …）。 */
  resultCode: string;
  args?: Record<string, unknown>;
  requestId?: string;
  durationMs?: number;
  /** 幂等命中标记（重放返首次结果时为 true，便于观测"省了多少次执行"）。 */
  idempotentReplay?: boolean;
}

/** 落一条 mcp_tool_call 审计（成功/被拒/未注册工具同一事件名，resultCode 区分）。 */
export function emitToolCall(input: ToolCallAuditInput): void {
  const args = input.args ?? {};
  writeAudit(config.auditDir, {
    event: "mcp_tool_call",
    actorId: input.actorId,
    ip: input.ctx.ip,
    method: input.ctx.method,
    path: input.ctx.path,
    status: auditStatusFor(input.resultCode),
    detail: {
      patId: input.patId,
      tool: input.tool,
      resultCode: input.resultCode,
      resource: resourceOf(input.tool, args),
      args: sanitizeArgsForAudit(args),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.idempotentReplay ? { idempotentReplay: true } : {}),
    },
  });
}

export interface AuthFailureAuditInput {
  ctx: McpCallAuditCtx;
  /** 认证失败原因（authenticate.ts 的 McpAuthFailReason；仅审计可见，对客户端统一 401）。 */
  reason: string;
  /** 明文前缀（14 字符，不可认证）；非 PAT 形态时为 undefined——**绝不记完整 token**。 */
  patPrefix?: string;
  /** 已解析出主体时（如账号停用）可记 actorId；未知 token 时无。 */
  actorId?: string | null;
}

/** 落一条 mcp_auth_failure 审计（ip + patPrefix 级；token 绝不落盘）。 */
export function emitAuthFailure(input: AuthFailureAuditInput): void {
  writeAudit(config.auditDir, {
    event: "mcp_auth_failure",
    actorId: input.actorId ?? null,
    ip: input.ctx.ip,
    method: input.ctx.method,
    path: input.ctx.path,
    status: 401,
    detail: {
      reason: input.reason,
      ...(input.patPrefix ? { patPrefix: input.patPrefix } : {}),
    },
  });
}
