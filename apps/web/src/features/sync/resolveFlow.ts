// apps/web/src/features/sync/resolveFlow.ts
// 冲突双栏弹窗的裁决流【纯内核】：下一条选择、按钮可用性、裁决后出队/留队。
// 与 React/网络解耦，node 环境穷举单测。

import type { PendingConflict } from "../../store/sync";
import type { ResolveDecision, ResolveSyncConflictResult } from "../../api/localSync";

/**
 * 「自定义合并值」是否可用：必须有服务端当前版本快照作为编辑基底（theirs）。
 * 缺快照（theirs=null，老数据/服务端未给快照）时不提供合并编辑上下文，custom 禁用。
 */
export function canCustomResolve(c: PendingConflict | null | undefined): boolean {
  return !!c && c.theirs !== null && typeof c.theirs === "object";
}

/** 「采用服务器值」是否可用：需要存在服务端值。 */
export function canUseTheirs(c: PendingConflict | null | undefined): boolean {
  return !!c && c.theirs !== null && typeof c.theirs === "object";
}

/** 「保留我的值」始终可用（重放我本地提交的值）。 */
export function canUseMine(c: PendingConflict | null | undefined): boolean {
  return !!c;
}

/**
 * 一次裁决是否真正解决冲突（据实际后端语义）：
 *   - decision="theirs" 且服务端终态 status="dropped" → 已放弃我的值，解决。
 *   - decision="mine"/"custom" 且 status="accepted"    → 我的/合并值重放成功，解决。
 * 其余（status 为 conflict/quarantined/rejected，或带 reasonCode）= 重放再被拒，
 * 原冲突保留在队首，用户须改选 theirs 或稍后重试（绝不静默丢）。
 */
export function isConflictResolved(
  decision: ResolveDecision,
  result: ResolveSyncConflictResult | null,
): boolean {
  if (!result || !result.status) return false;
  if (decision === "theirs") return result.status === "dropped";
  return result.status === "accepted";
}

/** 从队列移除已解决项（按 incomingId 优先，clientOpId 兜底），返回新数组（不可变）。 */
export function removeResolved(
  queue: PendingConflict[],
  ref: { incomingId?: string; clientOpId?: string },
): PendingConflict[] {
  return queue.filter(
    (c) =>
      !(ref.incomingId && c.incomingId === ref.incomingId) &&
      !(ref.clientOpId && c.clientOpId === ref.clientOpId),
  );
}

/** 取下一条待裁决冲突（队首）；空队列返回 null。 */
export function nextConflict(queue: PendingConflict[]): PendingConflict | null {
  return queue.length > 0 ? queue[0]! : null;
}

/** custom 禁用时的说明（按钮 title）。 */
export const CUSTOM_DISABLED_REASON = "缺少服务器当前值，暂不支持自定义合并，请选择保留我的或采用服务器的值";
