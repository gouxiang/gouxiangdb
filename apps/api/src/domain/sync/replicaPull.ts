// beta.2 S3b-3b：下行同步泵编排器——一轮拉取（pull one round），三轨：record / 结构 / 工作区树。
// 设计权威：DESIGN-OFFLINE-SYNC.md §6（subscribe→bootstrap→pull）、§8.3（seq keyset）、
// §8.4（保 id 直插）、§8.6（结构/树回放只走注册表 apply）、§13（信封）。
//
// 分层（纯逻辑/副作用分离，守单文件 ≤300 行）：
//   - replicaPullTransport.ts：五个下行 HTTP 的窄接口 + Node 全局 fetch 实现（唯一网络副作用，不读 env）。
//   - replicaPullApply.ts    ：单条 PullOp 在写事务内的三轨回放（record 裸写 / 注册表 apply）。
//   - replicaPullState.ts    ：per-base / 工作区树游标的短事务读写原语（只用传入 tx、单调 max）。
//   - 本文件：订阅 →（空副本）引导导入 → 逐页「事务外拉页 + 短事务回放并推进游标」的一轮编排。
//
// 纪律：默认关首行返回空 summary（零查询零写、transport 零调用）；HTTP 严格在写事务外（不占串行写队列/
// 事务锁）；每「应用一页 + 推进游标」一个 withWriteTx("replica.pull.apply") 短事务；同一 PullPage 内
// 服务端 seq 全局混排，ops 严格按数组顺序逐条 apply（绝不先 record 后结构重排）；传输失败立即停本轮，
// 已提交页的游标不回滚（下轮从已确认游标继续，服务端 op 回放幂等兜底）。绝不写 local_outbox /
// sync_op_log / sync_entity_versions / sync_incoming；不建定时器、不挂路由、不接壳。

import { withWriteTx } from "../../db.js";
import { offlineReplicaEnabled, offlineNodeId, offlineClientId } from "../../configOfflineReplica.js";
import { importReplicaBootstrap } from "./replicaBootstrapImport.js";
import { applyPullOpTx } from "./replicaPullApply.js";
import {
  advanceBaseTx,
  advanceTreeTx,
  readBaseStateTx,
  readTreeStateTx,
} from "./replicaPullState.js";
import type { ReplicaPullTransport } from "./replicaPullTransport.js";
import { ReplicaTransportError } from "./replicaPullTransport.js";
import type { PullOp } from "./pull.js";

// 一站式再导出：调用方/测试只需 import 本文件即可拿到传输工厂、具名错误、回放/游标原语与主要类型。
export { createFetchPullTransport, ReplicaTransportError } from "./replicaPullTransport.js";
export type { ReplicaPullTransport } from "./replicaPullTransport.js";
export type { SubscribeResult, TreeSubscribeResult } from "./snapshot.js";
export type { ReplicaBootstrapPage } from "./bootstrap.js";
export type { PullPage, TreePullPage, PullOp } from "./pull.js";
export { applyPullOpTx } from "./replicaPullApply.js";
export type { PullApplyKind, PullApplyCtx } from "./replicaPullApply.js";
export { advanceBaseTx, advanceTreeTx, readBaseStateTx, readTreeStateTx } from "./replicaPullState.js";

const DEFAULT_PAGE_SIZE = 500;
const HARD_MAX_PAGE_SIZE = 2000; // 与 pullBaseOps/pullTreeOps 服务端硬上限一致。

export interface PullBaseSummary {
  baseId: string;
  /** 本轮是否对该 base 执行了空副本引导导入。 */
  bootstrapped: boolean;
  /** 应用的增量拉取页数（不含 bootstrap）。 */
  pages: number;
  opsApplied: number;
  skipped: number;
}

export interface PullTreeSummary {
  pages: number;
  opsApplied: number;
  skipped: number;
}

export interface PullRoundSummary {
  /** off 守门为 false（零查零写、transport 零调用）。 */
  ran: boolean;
  nodeId: string;
  clientId: string;
  bases: PullBaseSummary[];
  tree: PullTreeSummary;
  /** 任一 HTTP 传输失败（其后步骤本轮未执行；已提交游标不回滚）。 */
  transportError: boolean;
}

export interface PullDeps {
  transport: ReplicaPullTransport;
  /** 本地副本属主（本地库真实 User）。 */
  ownerUserId: string;
  /** 本轮要下行的远端 baseId 列表（按数组顺序逐个处理）。 */
  baseIds: string[];
  nodeId?: string;
  clientId?: string;
  /** 每页 op 数（默认 500，硬截到 1..2000）。 */
  pageSize?: number;
}

function emptySummary(nodeId: string, clientId: string): PullRoundSummary {
  return {
    ran: false, nodeId, clientId, bases: [], tree: { pages: 0, opsApplied: 0, skipped: 0 },
    transportError: false,
  };
}

/** 在一个短事务内按数组顺序回放整页 ops，再推进 per-base 游标；返回 (applied, skipped)。 */
async function applyBasePage(
  ops: PullOp[],
  nextCursor: string,
  authzVersion: number,
  nodeId: string,
  baseId: string,
  ownerUserId: string,
  now: Date,
): Promise<{ applied: number; skipped: number }> {
  return withWriteTx("replica.pull.apply", async (tx) => {
    let applied = 0;
    let skipped = 0;
    // 页内严格按服务端下发顺序（seq 升序、record/结构混排保全局因果）。
    for (const op of ops) {
      const kind = await applyPullOpTx(tx, op, { ownerUserId });
      if (kind === "skipped") skipped++;
      else applied++;
    }
    await advanceBaseTx(tx, {
      nodeId, remoteBaseId: baseId, cursorSeq: BigInt(nextCursor), authzVersion, now,
    });
    return { applied, skipped };
  });
}

async function applyTreePage(
  ops: PullOp[],
  nextCursor: string,
  treeVersion: string,
  authzVersion: number,
  nodeId: string,
  ownerUserId: string,
  now: Date,
): Promise<{ applied: number; skipped: number }> {
  return withWriteTx("replica.pull.applyTree", async (tx) => {
    let applied = 0;
    let skipped = 0;
    for (const op of ops) {
      const kind = await applyPullOpTx(tx, op, { ownerUserId });
      if (kind === "skipped") skipped++;
      else applied++;
    }
    await advanceTreeTx(tx, {
      nodeId, cursorSeq: BigInt(nextCursor), treeVersion, authzVersion, now,
    });
    return { applied, skipped };
  });
}

/**
 * 一轮下行：默认关首行返回空 summary。HTTP 全部在写事务之外；每页一个短事务回放 + 推进游标。
 */
export async function pullReplicaOnce(deps: PullDeps): Promise<PullRoundSummary> {
  if (!offlineReplicaEnabled()) {
    return emptySummary(offlineNodeId(), offlineClientId());
  }
  const nodeId = deps.nodeId ?? offlineNodeId();
  const clientId = deps.clientId ?? offlineClientId();
  const pageSize = Math.min(Math.max(deps.pageSize ?? DEFAULT_PAGE_SIZE, 1), HARD_MAX_PAGE_SIZE);
  const now = new Date();

  const summary = emptySummary(nodeId, clientId);
  summary.ran = true;

  // ───────────────── per-base：订阅 →（空副本）引导 → 逐页增量 ─────────────────
  for (const baseId of deps.baseIds) {
    const item: PullBaseSummary = { baseId, bootstrapped: false, pages: 0, opsApplied: 0, skipped: 0 };
    summary.bases.push(item);

    try {
      // ① 订阅（服务端 upsert sync_subscription；幂等，不重置服务端游标）。
      await deps.transport.subscribeBase(baseId, clientId);

      // ② 读本地副本游标，判空副本。
      const state = await withWriteTx("replica.pull.readBase", (tx) =>
        readBaseStateTx(tx, nodeId, baseId));

      // ③ 未做过基线快照 → 引导导入（门面自带单事务 + 置 replica_state 游标到 anchorSeq）。
      if (!state || !state.snapshotDone) {
        const page = await deps.transport.fetchBootstrap(baseId, clientId);
        const imported = await importReplicaBootstrap(page, { ownerUserId: deps.ownerUserId, nodeId });
        item.bootstrapped = imported.ran && !imported.alreadyBootstrapped;
      }

      // ④ 以引导/已存游标为起点逐页增量（重读一次，bootstrap 刚把游标写到 anchorSeq）。
      const fresh = await withWriteTx("replica.pull.readBase2", (tx) =>
        readBaseStateTx(tx, nodeId, baseId));
      let after = fresh?.pullCursorSeq ?? 0n;

      for (;;) {
        const page = await deps.transport.pullBase(baseId, after, clientId, pageSize);
        const r = await applyBasePage(
          page.ops, page.nextCursor, page.authzVersion, nodeId, baseId, deps.ownerUserId, now,
        );
        item.pages++;
        item.opsApplied += r.applied;
        item.skipped += r.skipped;
        after = BigInt(page.nextCursor);
        if (!page.hasMore) break;
      }
    } catch (e) {
      // 传输故障：本轮立即停（同一下行服务端，后续 base/树大概率同样不可达）；已提交游标不回滚。
      // 回放本身的业务错（坏 payload）不应被吞成 transportError——只归一 ReplicaTransportError。
      if (e instanceof ReplicaTransportError) {
        summary.transportError = true;
        return summary;
      }
      throw e;
    }
  }

  // ───────────────── 工作区树（跨 base 单例，所有 base 后做一次） ─────────────────
  try {
    await deps.transport.subscribeTree(clientId);
    const treeState = await withWriteTx("replica.pull.readTree", (tx) => readTreeStateTx(tx, nodeId));
    // 无行 / 未快照：树订阅即视为无需基线快照，从 0 拉全量增量。
    let after = !treeState || !treeState.snapshotDone ? 0n : treeState.pullCursorSeq;
    for (;;) {
      const page = await deps.transport.pullTree(after, clientId, pageSize);
      const r = await applyTreePage(
        page.ops, page.nextCursor, page.treeVersion, page.authzVersion, nodeId, deps.ownerUserId, now,
      );
      summary.tree.pages++;
      summary.tree.opsApplied += r.applied;
      summary.tree.skipped += r.skipped;
      after = BigInt(page.nextCursor);
      if (!page.hasMore) break;
    }
  } catch (e) {
    if (e instanceof ReplicaTransportError) {
      summary.transportError = true;
      return summary;
    }
    throw e;
  }

  return summary;
}
