// apps/api/src/domain/authz/enforceGate.ts
// 守卫唯一的执法接线缝：七守（guards.ts）与 KB 全路由（routes/kb/shared.ts）都只调本模块一次。
//
// 权限引擎已永久单一化（2026-10 戴总下令）：
//   - 引擎结论是【唯一、无条件、永久生效】的布尔裁决，不再有 off/shadow/on 三态、
//     不再有新旧对拍/drift 账本/READY 阶段门，也不读取 GX_AUTHZ_ENGINE；
//   - 引擎抛错 -> fail-closed：抛 503 并记 authz_engine_error，【绝不回落旧决策】，
//     从根上杜绝"两套裁决谁为准"的误判；
//   - 资源反查不到活 nav 节点 -> fail-closed 拒绝（403），记 authz_engine_unresolved；
//   - conjunction 语义只用于引擎动作词汇无法忠实表达该关卡硬规则的场合
//     （见 guards.requireCanDeleteBase / kb.enforceKbDelete），它只减不增：绝不因引擎更宽而放行。
//
// 边界：本层允许 import config/db/引擎与 HttpError，禁止 import Hono/guards
//（守卫 import 本层，反向禁止）。

import type { ResourceAction } from "@gx/shared-types";
import { engineDecideResource, type ResourceRef } from "./adapter.js";
import { HttpError } from "../../httpError.js";
import type { AuthzClient } from "./types.js";

/**
 * 引擎结论怎么用的语义。
 * 默认 authority（引擎为权威）；conjunction 仅用于引擎动作词汇无法忠实表达该关卡硬规则的
 * 场合（删库/删知识库借 "d" 作必要条件），它只减不增：绝不因引擎更宽而放行。
 */
export type EnforceSemantics = "authority" | "conjunction";

interface EnforceParams {
  /** 埋点来源（守卫名，如 requireCanView），按来源分桶排查。 */
  guard: string;
  userId: string;
  ref: ResourceRef;
  action: ResourceAction;
  /**
   * 库/知识库层裁决（libraryPolicy）：仅 conjunction 语义下作为必要条件之一参与
   * （删库 = legacy ∧ engine）；authority 语义下不再使用，保留入参以收敛调用形态。
   */
  legacyAllowed: boolean;
  client?: AuthzClient;
  semantics?: EnforceSemantics;
}

interface EnforceOutcome {
  /** 权威结论：守卫据此放行或抛 403。 */
  allowed: boolean;
  /** 结论来源：恒为引擎（永久单一化后无第二来源）。 */
  source: "engine";
  /** 引擎侧反查到的 nav 节点（null=资源反查不到活节点）。 */
  nodeId?: string | null;
}

/**
 * 守卫唯一入口：恒定由引擎裁决。
 * 引擎故障抛 503（fail-closed），资源无活节点返回拒绝（fail-closed）。
 */
export async function enforceOrLegacy(p: EnforceParams): Promise<EnforceOutcome> {
  let nodeId: string | null = null;
  let engineAllowed = false;
  try {
    const decided = await engineDecideResource(p.userId, p.ref, p.action, p.client);
    nodeId = decided.nodeId;
    engineAllowed = decided.engineAllowed;
  } catch (error) {
    reportEngineError(p.guard, p.action, nodeId, error);
    // fail-closed：引擎故障不回落任何旧决策，避免"两套裁决谁为准"；调用方统一走错误出口。
    throw new HttpError(503, "权限服务暂不可用");
  }

  if (!nodeId) {
    // 资源反查不到活节点：数据问题归 M3 reconcile，不当授权结论；fail-closed 拒绝。
    reportUnresolved(p.guard, p.action);
    return { allowed: false, source: "engine", nodeId: null };
  }

  const allowed = p.semantics === "conjunction" ? p.legacyAllowed && engineAllowed : engineAllowed;
  return { allowed, source: "engine", nodeId };
}

/**
 * 引擎抛错：fail-closed 拒绝前留可观测证据（结构化单行 JSON，供日志侧采集/告警）。
 * 日志不含 userId 明文/堆栈/响应体。
 */
function reportEngineError(
  guard: string,
  action: ResourceAction,
  nodeId: string | null,
  error: unknown,
  sink: (line: string) => void = (l) => console.error(l),
): void {
  sink(JSON.stringify({
    event: "authz_engine_error",
    guard,
    action,
    nodeId,
    denied: true,
    ts: new Date().toISOString(),
  }));
}

/**
 * 资源反查不到活 nav 节点：守卫已按 fail-closed 拒绝，打一条结构化事件
 * authz_engine_unresolved（denied=true 供值班核对，不静默）。
 */
function reportUnresolved(
  guard: string,
  action: ResourceAction,
  sink: (line: string) => void = (l) => console.error(l),
): void {
  sink(JSON.stringify({
    event: "authz_engine_unresolved",
    guard,
    action,
    nodeId: null,
    denied: true,
    ts: new Date().toISOString(),
  }));
}
