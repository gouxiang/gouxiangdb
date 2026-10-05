// M4/S3 shadow 对拍：旧守卫决策 vs 新引擎决策的差异分类、进程内环形计数与脱敏结构化日志。
//
// 纯域：只做分类/计数/日志组装，不 import Hono/guards，不读旧三表，也不直接调引擎。
// 旧决策与引擎决策都由适配层（adapter.ts）在守卫函数体内算出后传入——引擎权威单一，
// 本模块不重复任何授权判定。引擎在适配层抛错时由适配层吞掉记 error metric，绝不影响旧响应
//（fail-open 仅限 shadow 观测层：旧结果照返回，引擎永不参与放行/拒绝）。
//
// 分类（M4 计划 §4.8 行375-378 定稿，按风险方向命名）：
//   DRIFT_OVERDENY  = 旧 allow / 引擎 deny：新引擎更严，可能把用户锁外，可用性风险；
//   DRIFT_OVERALLOW = 旧 deny  / 引擎 allow：新引擎更宽，越权风险，零容忍。
// 两者生产影子期都须归零（§4.8 翻门条件 4，M4 比 M1 更严，可用性漂移不灰度容忍）。

import { createHash } from "node:crypto";
import type { ResourceAction } from "@gx/shared-types";

export type DriftKind = "DRIFT_OVERDENY" | "DRIFT_OVERALLOW";

/**
 * 对拍方向（R1 起区分）：
 *   forward = 影子期：旧决策为准、引擎只对比（off 后仍可回退到该姿态）；
 *   reverse = enforce 期：引擎为准、旧决策作对比基准（AUTHZ-LEGACY-GUARD-CLEANUP 阶段 R2）。
 * 分类口径两个方向完全一致（旧 vs 引擎），方向只影响日志/计数标记，不影响 kind 语义。
 */
type CompareDirection = "forward" | "reverse";

/** 一次对拍的最小上下文（来源标记 + 被决策资源/动作/主体）。 */
export interface ShadowCompareContext {
  /** 埋点来源（守卫名，如 requireCanView/requireKb/requireDocAccess），按来源分桶排查。 */
  guard: string;
  /** 被对拍的资源动作（r/c/u/d/comment/manage_share/manage_schema/manage_table）。 */
  action: ResourceAction;
  /** 被决策 nav 节点 id（资源反查不到时为 null，单独记 UNRESOLVED_NODE metric）。 */
  nodeId: string | null;
  /** 主体用户 id（仅用于哈希，不进日志明文）。 */
  userId: string;
  /** 对拍方向，缺省 forward（影子期口径）。 */
  direction?: CompareDirection;
}

interface DriftEntry {
  ts: string;
  kind: DriftKind;
  guard: string;
  action: ResourceAction;
  nodeId: string | null;
  userHash: string;
  oldAllowed: boolean;
  engineAllowed: boolean;
  /** 对拍方向（老条目缺省 forward）。 */
  direction?: CompareDirection;
}

/** 引擎对拍本身失败（区别于决策漂移）：只观测、不影响旧响应。 */
interface ShadowErrorEntry {
  ts: string;
  guard: string;
  action: ResourceAction;
  nodeId: string | null;
  userHash: string;
  /** 错误消息（可能含内部细节，仅入进程内环形缓冲，不落结构化日志明文）。 */
  message: string;
}

/** 进程内滚动计数（DriftSnapshot 的标量部分）。 */
interface DriftCounts {
  overDeny: number;
  overAllow: number;
  errors: number;
  unresolvedNode: number;
  compared: number;
  /** compared 中方向为 reverse（enforce 期，引擎为准）的次数。 */
  comparedReverse: number;
  /** on 态引擎抛错、守卫回落旧决策的次数（事件 authz_enforce_error）。 */
  enforceErrors: number;
  /** on 态反查不到活节点而 fail-closed 拒绝的次数（事件 authz_enforce_unresolved）。 */
  enforceUnresolved: number;
}

interface DriftSnapshot extends DriftCounts {
  recent: DriftEntry[];
  recentErrors: ShadowErrorEntry[];
}

/** 对主体 id 做不可逆短哈希（脱敏；仅用于在日志/环形缓冲中关联同一主体，不回推明文）。 */
export function hashSubjectId(userId: string): string {
  return createHash("sha256").update(`authz:${userId}`).digest("hex").slice(0, 12);
}

/**
 * 纯函数：把一对旧/引擎布尔决策分类。
 * 一致 -> null（无 drift）；旧允新拒 -> OVERDENY；旧拒新允 -> OVERALLOW。
 */
export function classifyDrift(oldAllowed: boolean, engineAllowed: boolean): DriftKind | null {
  if (oldAllowed === engineAllowed) return null;
  return oldAllowed && !engineAllowed ? "DRIFT_OVERDENY" : "DRIFT_OVERALLOW";
}

/**
 * 进程内滚动计数 + 最近 N=200 条环形缓冲（不落盘、不含响应体）。
 * 按类计数，最近条目供 runbook 现场排查；容量满后覆盖最旧。
 */
export class DriftRegistry {
  private cap: number;
  private ring: DriftEntry[] = [];
  private errorRing: ShadowErrorEntry[] = [];
  private cursor = 0;
  private errorCursor = 0;
  private counts = emptyCounts();

  constructor(capacity = 200) {
    this.cap = Math.max(1, capacity);
  }

  /** 记一次对拍；reverse（enforce 期）额外进 comparedReverse 桶。 */
  noteCompared(direction: CompareDirection = "forward"): void {
    this.counts.compared++;
    if (direction === "reverse") this.counts.comparedReverse++;
  }

  /**
   * 资源反查不到活 nav 节点。
   *   - 影子期（forward）：只观测、不做布尔对拍（数据问题归 M3 reconcile）；
   *   - enforce 期（reverse）：守卫已按 fail-closed 拒绝，此处记 enforceUnresolved 供告警。
   */
  noteUnresolvedNode(direction: CompareDirection = "forward"): void {
    this.counts.unresolvedNode++;
    if (direction === "reverse") this.counts.enforceUnresolved++;
  }

  /** on 态引擎抛错、守卫回落旧决策（事件 authz_enforce_error）。 */
  noteEnforceError(): void {
    this.counts.enforceErrors++;
  }

  record(entry: DriftEntry): DriftKind {
    if (entry.kind === "DRIFT_OVERDENY") this.counts.overDeny++;
    else this.counts.overAllow++;
    this.pushRing(entry);
    return entry.kind;
  }

  recordError(entry: ShadowErrorEntry): void {
    this.counts.errors++;
    if (this.errorRing.length < this.cap) this.errorRing.push(entry);
    else this.errorRing[this.errorCursor] = entry;
    this.errorCursor = (this.errorCursor + 1) % this.cap;
  }

  private pushRing(entry: DriftEntry): void {
    if (this.ring.length < this.cap) this.ring.push(entry);
    else this.ring[this.cursor] = entry;
    this.cursor = (this.cursor + 1) % this.cap;
  }

  /** 环形按时间先后（最旧 -> 最新）返回。 */
  private ordered<T>(ring: T[], cursor: number, full: boolean): T[] {
    if (!full) return ring.slice();
    return [...ring.slice(cursor), ...ring.slice(0, cursor)];
  }

  snapshot(): DriftSnapshot {
    return {
      ...this.counts,
      recent: this.ordered(this.ring, this.cursor, this.ring.length === this.cap),
      recentErrors: this.ordered(this.errorRing, this.errorCursor, this.errorRing.length === this.cap),
    };
  }

  /** 测试间清零（不影响模块级单例的容量）。 */
  reset(): void {
    this.ring = [];
    this.errorRing = [];
    this.cursor = 0;
    this.errorCursor = 0;
    this.counts = emptyCounts();
  }
}

function emptyCounts(): DriftCounts {
  return {
    overDeny: 0, overAllow: 0, errors: 0, unresolvedNode: 0,
    compared: 0, comparedReverse: 0, enforceErrors: 0, enforceUnresolved: 0,
  };
}

/** 模块级单例：守卫全进程共享同一计数/缓冲。 */
export const driftRegistry = new DriftRegistry(200);

function toEntry(
  kind: DriftKind,
  oldAllowed: boolean,
  engineAllowed: boolean,
  ctx: ShadowCompareContext,
  now: Date,
): DriftEntry {
  return {
    ts: now.toISOString(),
    kind,
    guard: ctx.guard,
    action: ctx.action,
    nodeId: ctx.nodeId,
    userHash: hashSubjectId(ctx.userId),
    oldAllowed,
    engineAllowed,
    direction: ctx.direction ?? "forward",
  };
}

/**
 * 对拍入口：分类 -> 计数 -> 打一条脱敏结构化日志 authz_drift。一致时仅增 compared 计数、无日志。
 * 返回 drift 类（null=一致）。日志只含 id 哈希/动作/nodeId/来源/布尔结果，绝不落 userId 明文或响应体。
 */
export function shadowCompare(
  oldAllowed: boolean,
  engineAllowed: boolean,
  ctx: ShadowCompareContext,
  now: Date = new Date(),
  sink: (line: string) => void = (l) => console.warn(l),
): DriftKind | null {
  const direction = ctx.direction ?? "forward";
  driftRegistry.noteCompared(direction);
  const kind = classifyDrift(oldAllowed, engineAllowed);
  if (!kind) return null;
  const entry = toEntry(kind, oldAllowed, engineAllowed, ctx, now);
  driftRegistry.record(entry);
  // 结构化单行 JSON，键集合稳定供日志侧采集；OVERALLOW 零容忍，日志级别仍走 warn（不抛错影响响应）。
  // direction 区分影子期（forward）与 enforce 期反向对拍（reverse），分类口径两向一致。
  sink(JSON.stringify({
    event: "authz_drift",
    kind,
    direction,
    guard: ctx.guard,
    action: ctx.action,
    nodeId: ctx.nodeId,
    userHash: entry.userHash,
    old: oldAllowed,
    engine: engineAllowed,
    ts: entry.ts,
  }));
  return kind;
}

/** 引擎对拍抛错：吞错记 error metric + 一条 error 日志（不含错误明文堆栈/响应体），旧响应不受影响。 */
export function shadowReportError(
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
  sink(JSON.stringify({
    event: "authz_shadow_error",
    guard: ctx.guard,
    action: ctx.action,
    nodeId: ctx.nodeId,
    userHash: hashSubjectId(ctx.userId),
    ts: now.toISOString(),
  }));
}

// enforce（on）态的两个专属事件（authz_enforce_error / authz_enforce_unresolved）
// 与 authz_shadow_error 同族同机制（同一个 driftRegistry），但只属于 enforce 接线，
// 故与账本扩展放在 enforceGate.ts，本文件保持"影子观测层"单一职责、不超 300 行。
