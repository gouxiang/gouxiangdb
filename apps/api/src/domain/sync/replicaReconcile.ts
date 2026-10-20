// beta.2 S4d：失权对账【编排器】——把 S4b 取数 / S4a 计划 / S4c 软删执行串成一轮，
// 并做 authzVersion 单调记账 + 事务提交后审计。
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §9.3（重连发现 authzVersion
// 变化 → 受限重快照，把不再可见的 record/字段从本地副本软删）、§9.5（审计事件
// sync_visibility_purged）、决策 D2（纯本地 base 永不擦）。
//
// 分层（与 replicaPull.ts 同纪律，副作用边界各自独立文件）：
//   - replicaInventory.ts      ：S4b 事务内只读取数（本地有什么）。
//   - replicaPurgePlan.ts      ：S4a 纯函数计划（服务端可见集与本地清单的差集，只算不执行）。
//   - replicaPurgeExecutor.ts  ：S4c 事务内软删执行（可逆软删、结构永不擦、宁残留不误删）。
//   - replicaReconcileState.ts ：本刀的 authzVersion 一列单调记账原语。
//   - 本文件                    ：单 base 事务体 reconcileVisibilityTx + 一轮编排 reconcileVisibilityOnce。
//
// 铁律：默认关——首行 offlineReplicaEnabled() 守门，关态零查零写、transport 零调用；HTTP 严格在
// 写事务外（不占串行写队列/事务锁）；每个 base 一个 withWriteTx("replica.reconcile.base") 短事务，
// 回调内只用传入 tx（禁再入队/再开事务）；审计 writeAudit 是【同步文件 IO】，本文件绝不 import
// writeAudit、也不读 config.auditDir——只在事务【成功提交后】调用依赖注入的 auditSink，且 try/catch
// 吞掉审计自身故障（审计永不阻断对账）；事务 throw 时绝不调用 sink。整轮一个 now。
//
// 明确【不在本刀范围】：
//   - visibility 返回 403（整节点失权）＝未来"销毁本地加密镜像"真机刀：本刀只记 deniedBaseIds，
//     不擦、不抛、不记账、不审计，继续处理后续 base；
//   - 附件/uploads 缓存擦除（另一轨）；
//   - 不建定时器、不挂路由、不接 pull 泵/壳；合入后本模块不被任何 src 生产代码 import。

import { withWriteTx } from "../../db.js";
import type { DbTx } from "../../db.js";
import { offlineReplicaEnabled, offlineNodeId } from "../../configOfflineReplica.js";
import { readBaseStateTx } from "./replicaPullState.js";
import { readReplicaInventoryTx } from "./replicaInventory.js";
import { buildReplicaPurgePlan, shouldReconcileAuthz } from "./replicaPurgePlan.js";
import { applyReplicaPurgeTx } from "./replicaPurgeExecutor.js";
import type { PurgeApplyResult } from "./replicaPurgeExecutor.js";
import { advanceReconcileAuthzTx } from "./replicaReconcileState.js";
import { ReplicaTransportError } from "./replicaPullTransport.js";
import type { VisibilityReport } from "./visibility.js";

// ───────────────────────── 传输窄接口（假实现即可单测，不改 replicaPullTransport） ─────────────────────────

/**
 * 失权可见集传输：GET /api/v1/sync/visibility?baseId= 的窄接口。
 * 返回已剥掉 {result} 信封的 VisibilityReport；非 2xx（含 403/5xx）/网络故障/坏 JSON
 * 一律抛 ReplicaTransportError（带 status），编排器据此分流。
 */
export interface ReplicaVisibilityTransport {
  fetchVisibility(baseId: string): Promise<VisibilityReport>;
}

// ───────────────────────── 提交后审计（依赖注入，事件内绝不许出现 id/字段值） ─────────────────────────

/**
 * 失权擦除审计事件（对应 AuditEventName "sync_visibility_purged"，本刀不直接落 JSONL）。
 * 隐私红线：只许 baseId / 前后版本 / reason / 聚合计数 / actorId——绝不含任何 record/link/field
 * 的 id 或字段值（失权主体不应再从审计行反推出被擦数据内容）。
 */
export interface ReconcileAuditEvent {
  actorId?: string | null;
  baseId: string;
  fromAuthzVersion: string | null;
  toAuthzVersion: string;
  /** 稳定原因码：取自 PurgePlan.reason（真正擦除时为 "ok"）。 */
  reasonCode: string;
  triggered: boolean;
  recordsSoftDeleted: number;
  linksSoftDeleted: number;
  recordsRescoped: number;
  fieldKeysStripped: number;
}

/** 由上层装配（生产形态包一层 writeAudit）；仅在事务提交后被同步调用。 */
export type ReconcileAuditSink = (e: ReconcileAuditEvent) => void;

// ───────────────────────── 单 base 事务体 ─────────────────────────

export interface ReconcileBaseInput {
  nodeId: string;
  /** 本地承载 base 的 id（副本保 id 直插，localBaseId===remoteBaseId）。 */
  localBaseId: string;
  /** 已在事务外取好的服务端可见集报告。 */
  report: VisibilityReport;
  now?: Date;
  actorUserId?: string;
}

export interface ReconcileBaseResult {
  baseId: string;
  outcome: "purged" | "noop" | "skipped_local_only" | "identical_authz_version";
  localAuthzVersion: string | null;
  serverAuthzVersion: number;
  /** authzVersion 列本次是否实际前进（skipped/identical 恒 false）。 */
  advanced: boolean;
  /** 仅 purged（实际执行了执行器）时给；noop/skipped/identical 不给。 */
  apply?: PurgeApplyResult;
  /** 仅"实际发生失权擦除"才非 null；版本不同但零差集不打 purged 点。 */
  audit: ReconcileAuditEvent | null;
}

function skippedResult(input: ReconcileBaseInput, localAuthzVersion: string | null): ReconcileBaseResult {
  return {
    baseId: input.localBaseId,
    outcome: "skipped_local_only",
    localAuthzVersion,
    serverAuthzVersion: input.report.authzVersion,
    advanced: false,
    audit: null,
  };
}

/**
 * 单 base 对账事务体（纯 tx；report 已在事务外取好）。五步闸顺序不可调：
 *  a) 无 replica_state 行 → skipped_local_only（不读 inventory、不 build、不记账、不审计）；
 *  b) authzVersion 未变 → identical_authz_version（同上，连 inventory 都不读）；
 *  c) inventory 自称纯本地 → skipped_local_only（D2 纵深防御，不依赖执行器抛错）；
 *  d) build 计划；
 *  e) triggered → 软删执行 + 单调记账前进 + purged + 审计事件；
 *     未 triggered 但版本不同 → 只记账前进（避免下轮重复全量对比），noop、不审计。
 */
export async function reconcileVisibilityTx(
  tx: DbTx,
  input: ReconcileBaseInput,
): Promise<ReconcileBaseResult> {
  const baseId = input.localBaseId;
  const serverAuthzVersion = input.report.authzVersion;

  // a) 读本地副本状态（无行＝纯本地 base，绝不擦）。
  const state = await readBaseStateTx(tx, input.nodeId, baseId);
  if (state === null) {
    return skippedResult(input, null);
  }
  const local = state.authzVersion;

  // b) 权限版本未变：零差集也不扫（§9.3 触发条件）。
  if (!shouldReconcileAuthz(local, serverAuthzVersion)) {
    return {
      baseId,
      outcome: "identical_authz_version",
      localAuthzVersion: local,
      serverAuthzVersion,
      advanced: false,
      audit: null,
    };
  }

  // c) 只读取数 + 纯本地纵深防御（inventory 口径比状态行更贴近真实数据）。
  const inventory = await readReplicaInventoryTx(tx, { nodeId: input.nodeId, localBaseId: baseId });
  if (inventory.isLocalOnly) {
    return skippedResult(input, local);
  }

  // d) 计算差集计划（纯函数，不执行）。
  const plan = buildReplicaPurgePlan({ report: input.report, inventory, localAuthzVersion: local });

  // e) 有差集：软删执行 → 记账；两步同一事务，任一失败整体回滚（擦了但没记账绝不可能发生）。
  if (plan.triggered) {
    const applied = await applyReplicaPurgeTx(tx, plan, {
      now: input.now ?? new Date(),
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
    });
    const advance = await advanceReconcileAuthzTx(tx, {
      nodeId: input.nodeId, remoteBaseId: baseId, authzVersion: serverAuthzVersion,
    });
    // 事件只带计数与版本，不带任何被擦 id/字段值。
    const audit: ReconcileAuditEvent = {
      actorId: input.actorUserId ?? null,
      baseId,
      fromAuthzVersion: local,
      toAuthzVersion: String(serverAuthzVersion),
      reasonCode: plan.reason,
      triggered: true,
      recordsSoftDeleted: applied.recordsSoftDeleted,
      linksSoftDeleted: applied.linksSoftDeleted,
      recordsRescoped: applied.recordsRescoped,
      fieldKeysStripped: applied.fieldKeysStripped,
    };
    return {
      baseId,
      outcome: "purged",
      localAuthzVersion: local,
      serverAuthzVersion,
      advanced: advance.advanced,
      apply: applied,
      audit,
    };
  }

  // 版本不同却零差集（empty/ok 零差集；local_only/identical 已在 a/b/c 拦掉）：不擦任何东西，
  // 但仍单调记账前进，避免下轮重复全量对比；不产生 purged 审计事件。
  const advance = await advanceReconcileAuthzTx(tx, {
    nodeId: input.nodeId, remoteBaseId: baseId, authzVersion: serverAuthzVersion,
  });
  return {
    baseId,
    outcome: "noop",
    localAuthzVersion: local,
    serverAuthzVersion,
    advanced: advance.advanced,
    audit: null,
  };
}

// ───────────────────────── 一轮编排 ─────────────────────────

export interface ReconcileRoundSummary {
  /** off 守门为 false（零查零写、transport 零调用）。 */
  ran: boolean;
  nodeId: string;
  results: ReconcileBaseResult[];
  /** visibility 返回 403 的 base（整节点失权嫌疑）：不擦不抛，留待上层真机刀。 */
  deniedBaseIds: string[];
  /** 403 之外的传输故障（网络/5xx/坏 JSON/缺信封）：其后 base 本轮未处理。 */
  transportError: boolean;
}

export interface ReconcileDeps {
  transport: ReplicaVisibilityTransport;
  /** 本轮要对账的远端 baseId 列表（按数组顺序逐个处理；保 id 直插下同时是 localBaseId）。 */
  baseIds: string[];
  nodeId?: string;
  actorUserId?: string;
  /** 注入整轮单一时间戳；缺省编排入口 new Date() 一次。 */
  now?: Date;
  /** 提交后审计回调（生产形态由上层包 writeAudit）；不给则不审计。 */
  auditSink?: ReconcileAuditSink;
}

/**
 * 一轮失权对账：默认关首行返回空 summary。HTTP 全部在写事务之外；每 base 一个短事务；
 * 403 收 deniedBaseIds 继续；其他传输错立即停本轮（与 pull 同口径，已提交事务不回滚）；
 * 非传输错原样 throw；审计仅在事务成功提交后触发，且自身故障不阻断对账。
 */
export async function reconcileVisibilityOnce(deps: ReconcileDeps): Promise<ReconcileRoundSummary> {
  if (!offlineReplicaEnabled()) {
    return { ran: false, nodeId: offlineNodeId(), results: [], deniedBaseIds: [], transportError: false };
  }
  const nodeId = deps.nodeId ?? offlineNodeId();
  const now = deps.now ?? new Date();
  const summary: ReconcileRoundSummary = {
    ran: true, nodeId, results: [], deniedBaseIds: [], transportError: false,
  };

  for (const baseId of deps.baseIds) {
    // ① HTTP 在事务外。
    let report: VisibilityReport;
    try {
      report = await deps.transport.fetchVisibility(baseId);
    } catch (e) {
      if (e instanceof ReplicaTransportError) {
        if (e.status === 403) {
          // 整节点失权嫌疑：本刀绝不擦/不销毁加密镜像，只登记后继续。
          summary.deniedBaseIds.push(baseId);
          continue;
        }
        summary.transportError = true;
        return summary;
      }
      throw e;
    }

    // ② 单 base 短事务（读状态 → 取数 → 计划 → 软删 → 记账，全在一个事务内）。
    const result = await withWriteTx("replica.reconcile.base", (tx) =>
      reconcileVisibilityTx(tx, { nodeId, localBaseId: baseId, report, now, actorUserId: deps.actorUserId }));
    summary.results.push(result);

    // ③ 仅在事务成功提交后审计；sink 自身故障只吞不抛（与 writeAudit 口径一致）。
    if (result.audit && deps.auditSink) {
      try {
        deps.auditSink(result.audit);
      } catch {
        // 审计失败永不阻断对账主流程。
      }
    }
  }

  return summary;
}
