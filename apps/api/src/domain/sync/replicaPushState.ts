// beta.2 S3a：推送泵的【短事务状态机原语】（DB 副作用边界）。
// 设计权威：DESIGN-OFFLINE-SYNC.md §5（发件箱状态 pending→pushing→acked/conflict/…）、§8.5（部分接受不回滚）。
//
// 每个函数都是一个独立短事务体（由编排器经 withWriteTx 入串行队列调用）：
//   - 回调内只用传入 tx，绝不再入写队列（并发度 1 自死锁）；
//   - 不发网络（HTTP 严格在事务外）；异常原样抛出，不吞错。

import type { LocalOutbox } from "@prisma/client";
import type { DbTx } from "../../db.js";
import { ADAPT_MALFORMED_CODE } from "./replicaPushAdapter.js";
import type { WirePushResult } from "./replicaPushTransport.js";

const MAX_LAST_ERROR = 500;

/** 终态计数（按权威端 status 归一；malformed 单列以便观测适配坏行）。 */
export interface OutcomeCounts {
  acked: number;
  conflict: number;
  rejected: number;
  quarantined: number;
  dropped: number;
  malformed: number;
}

export function emptyCounts(): OutcomeCounts {
  return { acked: 0, conflict: 0, rejected: 0, quarantined: 0, dropped: 0, malformed: 0 };
}

export function truncateErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.length > MAX_LAST_ERROR ? msg.slice(0, MAX_LAST_ERROR) : msg;
}

/** claim：发前把本批行置 pushing、attempts+1。 */
export async function claimRowsTx(tx: DbTx, ids: string[], now: Date): Promise<void> {
  await tx.localOutbox.updateMany({
    where: { id: { in: ids } },
    data: { status: "pushing", attempts: { increment: 1 }, updatedAt: now },
  });
}

/** 适配坏行 / baseId 异常行：落 rejected=SYNC_MALFORMED_PAYLOAD（op 不丢、不参与发送）。 */
export async function rejectMalformedTx(
  tx: DbTx,
  rows: { clientOpId: string }[],
  detail: string[],
  now: Date,
): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    await tx.localOutbox.update({
      where: { clientOpId: rows[i]!.clientOpId }, // clientOpId @unique，无需 Prisma 行 id
      data: {
        status: "rejected", reasonCode: ADAPT_MALFORMED_CODE,
        lastError: truncateErr(detail[i] ?? "malformed"), updatedAt: now,
      },
    });
  }
}

/** 传输成功后按 clientOpId 回执逐条落终态；返回本批终态计数。 */
export async function settleRowsTx(
  tx: DbTx,
  rows: LocalOutbox[],
  results: WirePushResult[],
  now: Date,
): Promise<OutcomeCounts> {
  const byOp = new Map<string, WirePushResult>();
  for (const r of results) byOp.set(r.clientOpId, r);
  const counts = emptyCounts();

  for (const row of rows) {
    const res = byOp.get(row.clientOpId);
    // 回执缺该 op：权威端不应如此，但不能丢行——回 pending 下轮重发（服务端幂等兜底）。
    if (!res) {
      await tx.localOutbox.update({
        where: { clientOpId: row.clientOpId },
        data: { status: "pending", lastError: "回执缺少该 op，等待重发", updatedAt: now },
      });
      continue;
    }

    if (res.status === "accepted") {
      await tx.localOutbox.update({
        where: { clientOpId: row.clientOpId },
        data: { status: "acked", serverClientOpId: res.clientOpId, reasonCode: null, lastError: null, updatedAt: now },
      });
      counts.acked++;
    } else if (res.status === "conflict") {
      await tx.localOutbox.update({
        where: { clientOpId: row.clientOpId },
        data: {
          status: "conflict",
          reasonCode: res.reasonCode ?? null,
          conflictPayload: JSON.stringify({
            serverVersion: res.serverVersion ?? null,
            reasonCode: res.reasonCode ?? null,
            reasonDetail: res.reasonDetail ?? null,
          }),
          updatedAt: now,
        },
      });
      counts.conflict++;
    } else if (res.status === "quarantined") {
      await tx.localOutbox.update({
        where: { clientOpId: row.clientOpId },
        data: { status: "quarantined", reasonCode: res.reasonCode ?? null, updatedAt: now },
      });
      counts.quarantined++;
    } else if (res.status === "dropped") {
      // 用户已在服务端放弃 → 本地也落 dropped 终态（不重发、不复活）。
      await tx.localOutbox.update({
        where: { clientOpId: row.clientOpId },
        data: { status: "dropped", reasonCode: res.reasonCode ?? null, updatedAt: now },
      });
      counts.dropped++;
    } else {
      // rejected（含任何未知终态，保守按拒绝终态，不重发）。
      await tx.localOutbox.update({
        where: { clientOpId: row.clientOpId },
        data: { status: "rejected", reasonCode: res.reasonCode ?? null, updatedAt: now },
      });
      counts.rejected++;
    }
  }
  return counts;
}

/** 传输失败：本批行回 pending、lastError 写截断错误（attempts 已在 claim 时 +1，不回滚）。 */
export async function requeueRowsTx(tx: DbTx, rows: LocalOutbox[], err: unknown, now: Date): Promise<void> {
  await tx.localOutbox.updateMany({
    where: { clientOpId: { in: rows.map((r) => r.clientOpId) } },
    data: { status: "pending", lastError: truncateErr(err), updatedAt: now },
  });
}
