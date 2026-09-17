// M6/S3 工具注册枢纽（闸门一）：按 PAT scope 粗筛 + 族可见集非空，决定"注册哪些工具"。
//
// 铁律：
//   1. 未注册的工具对客户端**不存在**——直调返回与"真不存在的工具名"逐字节一致的 UNKNOWN_TOOL
//      （由 SDK 天然实现，S3 用 golden 锁定该口径，不泄漏存在性）。
//   2. 引擎故障**不得**让 /mcp 500：某族可见集求解抛错时该族工具缺席 + 记 metric，其余族不受影响。
//   3. handler 只编排；资源判定经权限端口（M4），不 import 旧守卫、不裸查 prisma。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpPermissionPort, ResourceFamily } from "../permissions/types.js";
import { TOOL_CATALOG } from "./catalog.js";
import type { ToolCtx, ToolMeta } from "./types.js";

export interface ToolDeps {
  /** 权限端口（每请求按主体构建）；未接入时为 null -> 仅注册不涉资源的连接性工具。 */
  port?: McpPermissionPort | null;
  /** 引擎故障等诊断（生产接 metric；测试断言）。 */
  onMetric?: (m: { event: string; family?: ResourceFamily | null; tool?: string; error?: string }) => void;
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
    const acc = await port.listAccessibleResources(family);
    const has = Object.values(acc.byKind).some((ids) => (ids?.length ?? 0) > 0);
    return { ok: has, truncated: acc.truncated };
  } catch (err) {
    // 引擎故障：该族工具缺席（不注册），记 metric，绝不 500/抛错。
    onMetric?.({ event: "mcp.gate1.engine_error", family, tool: meta.name, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, truncated: false };
  }
}

/** 注册该主体可见的工具（异步：闸门一需查 M4 可见集）。 */
export async function registerTools(server: McpServer, subject: { userId: string; patId: string; scopes: readonly string[] }, deps: ToolDeps): Promise<void> {
  const ctx: ToolCtx = { subject: { ...subject, scopes: [...subject.scopes] } as ToolCtx["subject"], port: deps.port ?? null };

  for (const spec of TOOL_CATALOG) {
    if (spec.meta.available && !spec.meta.available()) continue; // 运行期可用性门（如 M5 未启用）
    if (!scopeAllows(spec.meta, subject.scopes)) continue; // 闸门一前半：PAT scope 粗筛
    if (spec.meta.family) {
      const vis = await familyVisible(deps.port ?? null, spec.meta.family, spec.meta, deps.onMetric);
      if (!vis.ok) continue; // 闸门一后半：族可见集为空/引擎故障 -> 不入册
      if (vis.truncated) deps.onMetric?.({ event: "mcp.gate1.scope_truncated", family: spec.meta.family, tool: spec.meta.name });
    }
    server.registerTool(
      spec.meta.name,
      {
        title: spec.meta.title,
        description: spec.meta.description,
        inputSchema: spec.inputShape,
        annotations: { readOnlyHint: spec.meta.readOnly },
      },
      async (args: Record<string, unknown>) => spec.run(ctx, args ?? {}),
    );
  }
}
