// M6/S3 工具注册枢纽（闸门一）：按 PAT scope 粗筛 + 族可见集非空，决定"注册哪些工具"。
// M6/S7 追加**调用信封**（本文件是唯一包装点，不改各 handler）：
//   ① 超时：Promise.race 30s（config.mcpToolTimeoutMs），超时返结构化 TIMEOUT 且响应正常返回（不挂死连接）；
//   ② 幂等：**写工具**（meta.readOnly===false）且入参带 requestId 时，落库 mcp_idempotency 去重（24h 窗）；
//   ③ 审计：每次 call 收尾落 mcp_tool_call（成功/被拒/超时都记，resultCode 区分）。
//
// 铁律：
//   1. 未注册的工具对客户端**不存在**——直调返回与"真不存在的工具名"逐字节一致的 UNKNOWN_TOOL
//      （由 SDK 天然实现，S3 用 golden 锁定该口径，不泄漏存在性）。
//      ⚠ 该路径**不经过本文件**（SDK 在调用回调前就拒了）→ UNKNOWN_TOOL 审计在 transport 层补记（见 streamableHttp.ts）。
//   2. 引擎故障**不得**让 /mcp 500：某族可见集求解抛错时该族工具缺席 + 记 metric，其余族不受影响。
//   3. handler 只编排；资源判定经权限端口（M4），不 import 旧守卫、不裸查 prisma。
//   4. 信封只做横切（超时/幂等/审计）；handler 抛出的异常**原样冒泡**（不吞错、不改语义），
//      但冒泡前释放幂等占位并记一条审计（AC-M6-4「每次调用入审计」不留缺口）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../../config.js";
import type { McpPermissionPort, ResourceFamily } from "../permissions/types.js";
import { emitToolCall, UNKNOWN_AUDIT_CTX, type McpCallAuditCtx } from "../audit.js";
import { finalizeIdempotency, idempotencyKey, releaseIdempotency, reserveIdempotency } from "../idempotency.js";
import { TOOL_CATALOG } from "./catalog.js";
import type { ToolCtx, ToolMeta, ToolResult, ToolSpec } from "./types.js";

export interface ToolDeps {
  /** 权限端口（每请求按主体构建）；未接入时为 null -> 仅注册不涉资源的连接性工具。 */
  port?: McpPermissionPort | null;
  /** 引擎故障等诊断（生产接 metric；测试断言）。 */
  onMetric?: (m: { event: string; family?: ResourceFamily | null; tool?: string; error?: string }) => void;
  /** 审计来源（HTTP: 真实 ip/有效路径；stdio: STDIO_AUDIT_CTX）。缺省 unknown（不应出现在正常路径）。 */
  audit?: McpCallAuditCtx;
  /**
   * 注册完成回调：回传本请求**实际注册**的工具名（闸门一决策产物）。
   * 用途：transport 层据此判定"直调的 tool 是否未注册"（UNKNOWN_TOOL 审计由 SDK 直接拒，信封拿不到控制权）。
   */
  onRegistered?: (names: string[]) => void;
}

/** PAT scope 是否覆盖该工具（空 scopes=连接性工具，恒过）。 */
function scopeAllows(meta: ToolMeta, scopes: readonly string[]): boolean {
  return meta.scopes.length === 0 || meta.scopes.some((s) => scopes.includes(s));
}

/** 求某族的可见集；抛错时返回 null（调用方据此跳过该族，不冒泡）。 */
async function familyVisible(
  port: McpPermissionPort | null,
  family: ResourceFamily,
  meta: ToolMeta,
  onMetric: ToolDeps["onMetric"],
): Promise<{ ok: boolean; truncated: boolean }> {
  if (!port) return { ok: false, truncated: false };
  try {
    // 闸门一按**该工具所需动作**求可见集（裁决 b）：读工具 ["r"]、写工具 ["c"|"u"|"d"]
    const acc = await port.listAccessibleResources(family, meta.actions ?? ["r"]);
    const has = Object.values(acc.byKind).some((ids) => (ids?.length ?? 0) > 0);
    return { ok: has, truncated: acc.truncated };
  } catch (err) {
    // 引擎故障：该族工具缺席（不注册），记 metric，绝不 500/抛错。
    onMetric?.({ event: "mcp.gate1.engine_error", family, tool: meta.name, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, truncated: false };
  }
}

/* ------------------------------ M6/S7 调用信封 ------------------------------ */

/** 从 ToolResult 提取 §317 resultCode（isError 时取结构化 code；非 isError 即 OK）。 */
export function resultCodeOf(result: ToolResult): string {
  if (!result?.isError) return "OK";
  try {
    const parsed = JSON.parse(result.content?.[0]?.text ?? "") as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { code?: unknown }).code === "string") {
      return (parsed as { code: string }).code;
    }
  } catch {
    /* 非 JSON 文本：落到兜底 */
  }
  return "INVALID_PARAMS";
}

/** 超时哨兵（Symbol 保证不与任何 ToolResult 混淆）。 */
const TIMED_OUT = Symbol("mcp.timeout");

/** 超时结果：不声称成功/失败（写可能已落库），引导客户端先重读再决策（§409）。 */
function timeoutResult(tool: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          code: "TIMEOUT",
          message: `工具 ${tool} 超过 ${config.mcpToolTimeoutMs}ms 未返回：服务端已停止等待，但该写操作是否落库未知，请先重读资源状态再决定是否重试（勿盲目重放）。`,
        }),
      },
    ],
    isError: true,
  };
}

/** 并发同 requestId 且首调仍在执行：结构化拒绝（绝不 500，不臆造成功）。 */
function inProgressResult(tool: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ code: "IN_PROGRESS", message: `工具 ${tool} 的同一 requestId 正在处理中；请稍后用同一 requestId 重试以取得首次结果。` }),
      },
    ],
    isError: true,
  };
}

async function withTimeout(promise: Promise<ToolResult>, ms: number): Promise<ToolResult | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 单次调用的信封：幂等占位 -> 超时执行 -> 回填/释放 -> 审计。
 * 幂等仅在「写工具 + 入参带 requestId」时生效（读工具与无 requestId 的调用逐字节维持原行为）。
 */
async function invokeWithEnvelope(spec: ToolSpec, ctx: ToolCtx, args: Record<string, unknown>, deps: ToolDeps): Promise<ToolResult> {
  const auditCtx = deps.audit ?? UNKNOWN_AUDIT_CTX;
  const started = Date.now();
  const tool = spec.meta.name;
  const requestId = typeof args.requestId === "string" && args.requestId.length > 0 ? args.requestId : undefined;
  const key =
    spec.meta.readOnly === false && requestId
      ? idempotencyKey(ctx.subject.patId, tool, requestId)
      : undefined;

  if (key) {
    const reserved = await reserveIdempotency(key, ctx.subject.patId, tool);
    if (reserved.kind === "replay") {
      const first = JSON.parse(reserved.responseJson) as ToolResult;
      emitToolCall({
        ctx: auditCtx, actorId: ctx.subject.userId, patId: ctx.subject.patId, tool,
        resultCode: resultCodeOf(first), args, requestId, durationMs: Date.now() - started, idempotentReplay: true,
      });
      return first;
    }
    if (reserved.kind === "in_progress") {
      const result = inProgressResult(tool);
      emitToolCall({ ctx: auditCtx, actorId: ctx.subject.userId, patId: ctx.subject.patId, tool, resultCode: "IN_PROGRESS", args, requestId, durationMs: Date.now() - started });
      return result;
    }
  }

  let result: ToolResult;
  let timedOut = false;
  try {
    const raced = await withTimeout(spec.run(ctx, args), config.mcpToolTimeoutMs);
    if (raced === TIMED_OUT) {
      timedOut = true;
      result = timeoutResult(tool);
    } else {
      result = raced;
    }
  } catch (e) {
    // handler 异常原样冒泡；但先释放占位（不得把"未完成"固化成首次结果）并留审计（AC-M6-4 零缺口）。
    if (key) await releaseIdempotency(key).catch(() => undefined);
    emitToolCall({
      ctx: auditCtx, actorId: ctx.subject.userId, patId: ctx.subject.patId, tool,
      // INTERNAL_ERROR 仅用于审计（§317 词汇表描述的是"工具级"结果码；本码标记适配层未预期异常）
      resultCode: "INTERNAL_ERROR", args, requestId, durationMs: Date.now() - started,
    });
    throw e;
  }

  if (key) {
    if (timedOut) {
      // 超时结果不确定 -> 释放占位，允许后续重放重新执行（客户端应先重读再重试）
      await releaseIdempotency(key).catch(() => undefined);
    } else {
      await finalizeIdempotency(key, JSON.stringify(result)).catch(() => undefined);
    }
  }

  emitToolCall({
    ctx: auditCtx, actorId: ctx.subject.userId, patId: ctx.subject.patId, tool,
    resultCode: timedOut ? "TIMEOUT" : resultCodeOf(result), args, requestId, durationMs: Date.now() - started,
  });
  return result;
}

/** 注册该主体可见的工具（异步：闸门一需查 M4 可见集）。 */
export async function registerTools(server: McpServer, subject: { userId: string; patId: string; scopes: readonly string[] }, deps: ToolDeps): Promise<void> {
  const ctx: ToolCtx = { subject: { ...subject, scopes: [...subject.scopes] } as ToolCtx["subject"], port: deps.port ?? null };
  const registered: string[] = [];

  for (const spec of TOOL_CATALOG) {
    if (spec.meta.available && !spec.meta.available()) continue; // 运行期可用性门（如 M5 未启用）
    if (!scopeAllows(spec.meta, subject.scopes)) continue; // 闸门一前半：PAT scope 粗筛
    if (spec.meta.family) {
      const vis = await familyVisible(deps.port ?? null, spec.meta.family, spec.meta, deps.onMetric);
      if (!vis.ok) continue; // 闸门一后半：族可见集为空/引擎故障 -> 不入册
      if (vis.truncated) deps.onMetric?.({ event: "mcp.gate1.scope_truncated", family: spec.meta.family, tool: spec.meta.name });
    }
    registered.push(spec.meta.name);
    server.registerTool(
      spec.meta.name,
      {
        title: spec.meta.title,
        description: spec.meta.description,
        inputSchema: spec.inputShape,
        annotations: { readOnlyHint: spec.meta.readOnly },
      },
      async (args: Record<string, unknown>) => invokeWithEnvelope(spec, ctx, args ?? {}, deps),
    );
  }
  deps.onRegistered?.(registered);
}
