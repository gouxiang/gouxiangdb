// apps/api/src/domain/authz/enforceGate.ts
// M4/R1 七守 enforce 接线原语：把「三态模式 × 旧决策 × 引擎结论」收敛成守卫唯一的一次调用，
// 七个关卡（guards.ts）不再各自写一套分支，也不再直接碰引擎。
//
// 三态语义（ADR-0037 / docs/decisions/AUTHZ-LEGACY-GUARD-CLEANUP.md 阶段 R1）：
//   off    —— 旧决策为准，【零引擎 IO、零新增 SQL】，响应与现网逐字节一致；
//   shadow —— 旧决策为准，正向对拍（旧 vs 引擎）只分类计数 + 脱敏日志，不改响应；
//   on     —— 引擎结论为权威：
//               · nodeId 反查不到活 nav 节点 -> 计 UNRESOLVED_NODE 并 fail-closed 拒绝（不一律放行）；
//               · 对拍方向反转（引擎为准、旧决策作对比基准），分类口径与 forward 完全一致，
//                 日志/计数带 direction=reverse 以便与影子期区分；
//               · 引擎抛错 -> 回落旧决策（fail-safe，避免引擎单点故障导致全站不可用），
//                 同时记 authz_enforce_error 与告警计数，绝不静默吞掉。
//
// 边界（同 adapter.ts 纪律）：本层允许 import config/db 与引擎，禁止 import Hono/guards
//（守卫 import 本层，反向禁止）；漂移账本只走 shadow.ts 的 driftRegistry，禁止第二套。

import type { ResourceAction } from "@gx/shared-types";
import { effectiveAuthzMode, type AuthzEngineMode } from "../../configAuthz.js";
import { engineDecideResource, runShadowCheck, type ResourceRef } from "./adapter.js";
import {
  driftRegistry,
  hashSubjectId,
  shadowCompare,
  type DriftKind,
  type ShadowCompareContext,
} from "./shadow.js";
import type { AuthzClient } from "./types.js";

/**
 * on 态下「引擎结论怎么用」的语义。
 * 默认 authority（引擎为权威）；conjunction 仅用于引擎动作词汇无法忠实表达该关卡硬规则的
 * 场合（见 guards.requireCanDeleteBase），它只减不增：绝不因引擎更宽而放行。
 */
export type EnforceSemantics = "authority" | "conjunction";

interface EnforceParams {
  /** 埋点来源（守卫名，如 requireCanView），按来源分桶排查。 */
  guard: string;
  userId: string;
  ref: ResourceRef;
  action: ResourceAction;
  /** 旧（第二代 libraryPolicy）决策：off/shadow 恒为准，on 态作反向对拍基线。 */
  legacyAllowed: boolean;
  client?: AuthzClient;
  semantics?: EnforceSemantics;
  /**
   * 显式覆盖生效模式（仅翻转演练/单测用）。生产守卫恒不传、走 effectiveAuthzMode()，
   * 即总门 AUTHZ_ENFORCE_READY 未翻时 on 仍被降级为 shadow——不得靠本参数绕过阶段门。
   */
  mode?: AuthzEngineMode;
}

interface EnforceOutcome {
  /** 权威结论：守卫据此放行或抛 403。 */
  allowed: boolean;
  /** 结论来源。on 态引擎故障回落时 source=legacy 且 degraded=true。 */
  source: "engine" | "legacy";
  /** 对拍方向（off 无对拍，不返回）。 */
  direction?: "forward" | "reverse";
  /** 对拍分类：一致为 null；OVERDENY=旧允引擎拒（误拒风险），OVERALLOW=旧拒引擎允（越权风险）。 */
  drift?: DriftKind | null;
  /** 引擎侧反查到的 nav 节点（null=资源反查不到活节点）。 */
  nodeId?: string | null;
  /** on 态引擎抛错、已回落旧决策并计 authz_enforce_error。 */
  degraded?: boolean;
  /** on 态反查不到活节点、按 fail-closed 拒绝并计 UNRESOLVED_NODE。 */
  unresolvedNode?: boolean;
}

/**
 * 守卫唯一入口。off/shadow 两态的返回逐值等于旧决策（响应零漂移的根据）；
 * 只有生效模式真正为 on 时结论才由引擎决定。
 */
export async function enforceOrLegacy(p: EnforceParams): Promise<EnforceOutcome> {
  const mode = p.mode ?? effectiveAuthzMode();

  if (mode === "off") {
    // 短路：不实例化引擎、不点查 nav/策略，零新增 SQL。
    return { allowed: p.legacyAllowed, source: "legacy" };
  }

  if (mode === "shadow") {
    // 正向对拍：旧为准，引擎只对比；conjunction 借位不可比，runShadowCheck 内部跳过对拍。
    await runShadowCheck(p.guard, p.userId, p.ref, p.action, p.legacyAllowed, p.client, p.semantics);
    return { allowed: p.legacyAllowed, source: "legacy", direction: "forward" };
  }

  return enforceWithEngine(p);
}

/** on 态：以引擎结论为权威（conjunction 时为必要条件），旧决策反向对拍。 */
async function enforceWithEngine(p: EnforceParams): Promise<EnforceOutcome> {
  const ctx: ShadowCompareContext = { guard: p.guard, action: p.action, nodeId: null, userId: p.userId };

  let nodeId: string | null = null;
  let engineAllowed = false;
  try {
    const decided = await engineDecideResource(p.userId, p.ref, p.action, p.client);
    nodeId = decided.nodeId;
    engineAllowed = decided.engineAllowed;
  } catch (error) {
    // fail-safe：引擎故障不得让全站不可用，回落旧决策；但必须留可观测证据。
    reportEnforceError({ ...ctx, nodeId }, error);
    return { allowed: p.legacyAllowed, source: "legacy", degraded: true };
  }

  if (!nodeId) {
    // 资源反查不到活节点：数据问题归 M3 reconcile，不当授权结论；fail-closed 拒绝并计数。
    reportEnforceUnresolved(ctx);
    return { allowed: false, source: "engine", nodeId: null, unresolvedNode: true };
  }

  // 反向对拍：分类口径（旧 vs 引擎）与 forward 完全一致，仅 direction 标记不同，
  // 计数仍进 driftRegistry 的 overDeny/overAllow 两个桶（不新开账本）。
  const drift = shadowCompare(p.legacyAllowed, engineAllowed, { ...ctx, nodeId, direction: "reverse" });
  const allowed = p.semantics === "conjunction" ? p.legacyAllowed && engineAllowed : engineAllowed;
  return { allowed, source: "engine", direction: "reverse", drift, nodeId };
}

/**
 * enforce 态引擎抛错：守卫已回落旧决策（fail-safe，请求不受影响），此处与
 * authz_shadow_error 同族同机制记账——同一个 driftRegistry 的 error 环形缓冲，
 * 另增 enforceErrors 告警计数与独立事件名 authz_enforce_error。
 * 必须独立成事件：影子期的同类事件只意味着"少了一次对拍"，enforce 期它意味着
 * "这一条请求实际上没走引擎"，是必须告警的降级事实。日志不含错误明文/堆栈/响应体。
 */
export function reportEnforceError(
  ctx: ShadowCompareContext,
  error: unknown,
  now: Date = new Date(),
  sink: (line: string) => void = (l) => console.error(l),
): void {
  const message = error instanceof Error ? error.message : String(error);
  driftRegistry.recordError({
    ts: now.toISOString(),
    guard: ctx.guard,
    action: ctx.action,
    nodeId: ctx.nodeId,
    userHash: hashSubjectId(ctx.userId),
    message,
  });
  driftRegistry.noteEnforceError();
  sink(JSON.stringify({
    event: "authz_enforce_error",
    guard: ctx.guard,
    action: ctx.action,
    nodeId: ctx.nodeId,
    userHash: hashSubjectId(ctx.userId),
    fallback: "legacy",
    ts: now.toISOString(),
  }));
}

/**
 * enforce 态资源反查不到活 nav 节点：守卫已按 fail-closed 拒绝该请求，此处记
 * UNRESOLVED_NODE（与影子期同一账本）+ enforceUnresolved 告警计数，并打一条独立事件
 * authz_enforce_unresolved（denied=true 是 fail-closed 事实，供值班核对，不静默）。
 */
function reportEnforceUnresolved(
  ctx: ShadowCompareContext,
  now: Date = new Date(),
  sink: (line: string) => void = (l) => console.error(l),
): void {
  driftRegistry.noteUnresolvedNode("reverse");
  sink(JSON.stringify({
    event: "authz_enforce_unresolved",
    guard: ctx.guard,
    action: ctx.action,
    nodeId: ctx.nodeId,
    userHash: hashSubjectId(ctx.userId),
    denied: true,
    ts: now.toISOString(),
  }));
}
