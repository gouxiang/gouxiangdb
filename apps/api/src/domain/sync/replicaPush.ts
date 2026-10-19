// beta.2 S3a：出站推送泵编排器——一轮排空（drain one round）。
// 设计权威：DESIGN-OFFLINE-SYNC.md §5（发件箱）、§8.5（批内因果/部分接受不回滚）、§13（回执终态）。
//
// 分层（纯逻辑/副作用分离，且守单文件 ≤300 行）：
//   - replicaPushAdapter.ts：local_outbox 行 → wire op 的纯适配（无 DB/网络）。
//   - replicaPushTransport.ts：传输窄接口 + Node 全局 fetch 实现（唯一网络副作用，不读 env）。
//   - replicaPushState.ts：claim/settle/requeue/reject 的短事务状态机原语（只用传入 tx）。
//   - 本文件：选行 → 分组 → 适配 → 事务外发 HTTP → 短事务落终态 的一轮编排。
//
// 纪律：默认关首行返回空 summary（零查询零写）；网络严格在写事务之外（不占串行写队列/事务锁）；
// claim 仅置 pushing+attempts+1（崩溃残留可幂等重领）；网络错回 pending，靠服务端 clientOpId 幂等兜底，
// 已 acked 的桶绝不因后续桶失败而回滚。不做 pull（S3b）/冲突 UI（S5）/接壳/定时器/启动接线。

import { prisma, withWriteTx } from "../../db.js";
import type { LocalOutbox } from "@prisma/client";
import { offlineReplicaEnabled, offlineNodeId, offlineClientId } from "../../configOfflineReplica.js";
import { localOutboxRowToWireOp } from "./replicaPushAdapter.js";
import { isTreeEntityType } from "./navRegistry.js";
import {
  emptyCounts,
  claimRowsTx,
  rejectMalformedTx,
  settleRowsTx,
  requeueRowsTx,
  type OutcomeCounts,
} from "./replicaPushState.js";
import type { ReplicaPushTransport, WirePushOp, WirePushResult } from "./replicaPushTransport.js";

// 一站式再导出：调用方/测试只需 import 本文件即可拿到适配纯函数、传输工厂、具名错误与类型。
export { createFetchPushTransport, ReplicaTransportError } from "./replicaPushTransport.js";
export type {
  ReplicaPushTransport, WirePushOp, WirePushResult, BasePushResponse, TreePushResponse,
} from "./replicaPushTransport.js";
export { localOutboxRowToWireOp, ADAPT_MALFORMED_CODE } from "./replicaPushAdapter.js";
export type { AdaptResult, AdaptFailReason, OutboxAdapterRow } from "./replicaPushAdapter.js";
export type { OutcomeCounts } from "./replicaPushState.js";

const DEFAULT_BATCH_SIZE = 500;
const HARD_MAX_OPS = 1000; // 权威端单批硬上限 PUSH_MAX_OPS，batchSize 只能截到这里。

/** 单个发送桶（一个 base 或工作区树）的本轮结果。 */
export interface BucketOutcome {
  kind: "base" | "tree";
  baseId: string | null;
  sent: number;
  counts: OutcomeCounts;
}

export interface PushOutcomeSummary {
  ran: boolean;
  nodeId: string;
  clientId: string;
  /** 本轮各桶按发送顺序的结果。 */
  buckets: BucketOutcome[];
  /** 全桶汇总终态计数（含适配坏行落的 rejected/malformed）。 */
  totals: OutcomeCounts;
  /** 某桶传输失败（其后桶本轮未发送）。 */
  transportError: boolean;
  /** 跑完后仍有未排空行（pending/pushing）。 */
  hasRemaining: boolean;
}

export interface PushOutboxDeps {
  transport: ReplicaPushTransport;
  nodeId?: string;
  clientId?: string;
  /** 每轮最多取多少行（默认 500，硬截到 1000）。 */
  batchSize?: number;
}

function emptySummary(nodeId: string, clientId: string): PushOutcomeSummary {
  return {
    ran: false, nodeId, clientId, buckets: [], totals: emptyCounts(),
    transportError: false, hasRemaining: false,
  };
}

interface PlannedBucket {
  kind: "base" | "tree";
  baseId: string | null;
  rows: LocalOutbox[];
}

/** 内存分组：baseId 非空→按 base 桶（record+structure 混排保全局序）；树实体且 baseId=null→树桶。 */
function planBuckets(rows: LocalOutbox[]): { buckets: PlannedBucket[]; malformed: LocalOutbox[] } {
  const order: string[] = [];
  const byKey = new Map<string, PlannedBucket>();
  const malformed: LocalOutbox[] = [];

  for (const row of rows) {
    const isTree = row.baseId === null && isTreeEntityType(row.entityType);
    const isBase = row.baseId !== null && row.baseId !== "";
    if (!isTree && !isBase) {
      malformed.push(row); // baseId=null 又非树实体（或 baseId 空）：异常行落 rejected，不丢不发。
      continue;
    }
    const key = isTree ? "\u0000tree" : `base:${row.baseId}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { kind: isTree ? "tree" : "base", baseId: isTree ? null : row.baseId, rows: [] };
      byKey.set(key, bucket);
      order.push(key);
    }
    bucket.rows.push(row);
  }
  return { buckets: order.map((k) => byKey.get(k)!), malformed };
}

/**
 * 一轮排空：选 pending/pushing 行 → 分组/适配 → 桶内 claim（短事务）→ 事务外发 HTTP → 落终态（短事务）。
 * 默认关时首行返回空 summary（零查询零写）。
 */
export async function pushOutboxOnce(deps: PushOutboxDeps): Promise<PushOutcomeSummary> {
  if (!offlineReplicaEnabled()) {
    return emptySummary(offlineNodeId(), offlineClientId());
  }
  const nodeId = deps.nodeId ?? offlineNodeId();
  const clientId = deps.clientId ?? offlineClientId();
  const batchSize = Math.min(Math.max(deps.batchSize ?? DEFAULT_BATCH_SIZE, 1), HARD_MAX_OPS);
  const now = new Date();

  const summary = emptySummary(nodeId, clientId);
  summary.ran = true;

  // 选行：pending + 崩溃残留 pushing；按 createdAt、再按 id 保序（跨 base 全局因果，如先建表再建记录）。
  const rows = await prisma.localOutbox.findMany({
    where: { nodeId, status: { in: ["pending", "pushing"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: batchSize,
  });
  if (rows.length === 0) return summary;

  const { buckets, malformed } = planBuckets(rows);

  // 纯适配：坏行剔出落 rejected，绝不因单行坏抛崩整批（op 不丢）。
  const malformedRows: LocalOutbox[] = [...malformed];
  const malformedDetail: string[] = malformed.map(() => "baseId 与实体类型不匹配");
  const planned: { bucket: PlannedBucket; wire: WirePushOp[]; source: LocalOutbox[] }[] = [];
  for (const bucket of buckets) {
    const wire: WirePushOp[] = [];
    const source: LocalOutbox[] = [];
    for (const row of bucket.rows) {
      const r = localOutboxRowToWireOp(row);
      if (r.ok) { wire.push(r.op); source.push(row); }
      else { malformedRows.push(row); malformedDetail.push(r.detail); }
    }
    if (wire.length > 0) planned.push({ bucket, wire, source });
  }

  // 坏行一个短事务落 rejected（不发、不丢）。
  if (malformedRows.length > 0) {
    await withWriteTx("replicaPush.malformed", (tx) =>
      rejectMalformedTx(tx, malformedRows, malformedDetail, now));
    summary.totals.rejected += malformedRows.length;
    summary.totals.malformed += malformedRows.length;
  }

  // 逐桶发送：claim 与 settle 各自短事务，HTTP 严格在事务外。
  for (const { bucket, wire, source } of planned) {
    await withWriteTx("replicaPush.claim", (tx) =>
      claimRowsTx(tx, source.map((r) => r.id), now));

    let results: WirePushResult[];
    try {
      const resp = bucket.kind === "tree"
        ? await deps.transport.pushTree(wire, clientId)
        : await deps.transport.pushBase(bucket.baseId as string, wire, clientId);
      results = resp.results;
    } catch (e) {
      // 网络/非2xx：本批回 pending；已成功桶保持 acked 不回滚；其后桶本轮停（仍 pending/pushing）。
      await withWriteTx("replicaPush.requeue", (tx) => requeueRowsTx(tx, source, e, now));
      summary.transportError = true;
      summary.buckets.push({ kind: bucket.kind, baseId: bucket.baseId, sent: 0, counts: emptyCounts() });
      break;
    }

    const counts = await withWriteTx("replicaPush.settle", (tx) =>
      settleRowsTx(tx, source, results, now));
    summary.buckets.push({ kind: bucket.kind, baseId: bucket.baseId, sent: source.length, counts });
    for (const k of Object.keys(counts) as (keyof OutcomeCounts)[]) summary.totals[k] += counts[k]!;
  }

  // 本轮未能排空：仍有 pending/pushing（含因传输错误未发送的后续桶）。
  const remaining = await prisma.localOutbox.count({
    where: { nodeId, status: { in: ["pending", "pushing"] } },
  });
  summary.hasRemaining = remaining > 0;
  return summary;
}
