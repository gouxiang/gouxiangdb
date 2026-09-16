// M5/S1 检索 outbox 主库原语：业务写事务内登记 change_events（合并去重，同库同事务）。
//
// 边界（M5-implementation-plan §4.3/§5.2）：
//   - 本文件只提供 *Tx 事务原语，必须在调用方既有业务事务内、实体写成功后调用，
//     不自行开事务、不吞错；enqueue 失败随主事务整体回滚（共生死，验收双向断言）。
//   - 不写 search.db、不发外网、不读检索结果；search.db 写绝不进主事务（§3-2）。
//   - 与实体不建 FK；workspaceId 单工作区恒 ws_default。
//
// 合并去重（ARCH §7.1，§4.3）：同实体已有 pending/failed 事件则原地更新为最新
// version/op 并复位为 pending（lastError 清空、nextRunAt 立即）；processing/done
// 行不动——done 后再次编辑产生一条新事件行（保证已消费版本不被覆盖）。

import type { DbTx } from "../../db.js";

/** 可索引实体类型（与 change_events.entityType 对齐）。 */
export type ChangeEntityType = "record" | "doc" | "canvas";
/** 事件操作：upsert=建/改/恢复（重新抽文本建索引）；delete=软删/物理删（清派生行）。 */
export type ChangeOp = "upsert" | "delete";
/** 事件状态机（S5 worker 消费）；本原语只写 pending。 */
export type ChangeStatus = "pending" | "processing" | "done" | "failed" | "dead";

/** 合并候选状态：这两态的同实体事件被新编辑原地吸收；processing/done 不吸收。 */
const MERGEABLE_STATUS = ["pending", "failed"] as const;

export const DEFAULT_WORKSPACE = "ws_default";

export interface EnqueueChangeInput {
  entityType: ChangeEntityType;
  entityId: string;
  /**
   * upsert=新内容版本号；delete 传被删实体最后版本（worker 不据此取内容）。
   *
   * 用 bigint 而非 number：record 侧版本按 M5 计划 §5.2 取 Date.now() 毫秒（13 位，
   * 2026 年约 1.78e12），超出 32 位 Int 上限（2.1e9），SQLite INTEGER 为动态 64 位
   * 可直接存，Prisma 侧映射必须为 BigInt（schema ChangeEvent.version: BigInt）。
   * doc 侧传 BigInt(contentVersion)。
   */
  version: bigint;
  op: ChangeOp;
  workspaceId?: string;
}

export interface EnqueueChangeResult {
  /** "merged"=吸收进既有 pending/failed 行；"inserted"=新建一行（含 done 后再编辑）。 */
  outcome: "merged" | "inserted";
  /** 受影响的事件行 id（inserted 为新 id；merged 为被吸收行 id，单行）。 */
  eventId: string;
}

/**
 * 在调用方事务内登记一个实体变更事件（合并去重）。
 * 纯数据访问：只使用传入 tx；异常原样抛出让主事务回滚。
 */
export async function enqueueChangeEventTx(
  tx: DbTx,
  input: EnqueueChangeInput,
): Promise<EnqueueChangeResult> {
  const { entityType, entityId, version, op } = input;
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE;
  const now = new Date();

  // 1) 优先吸收同实体 pending/failed 行（正常至多一行；按 id 精确定位再更新，
  //    复位为最新版本/op/pending，立即到期，清历史错误与认领者）。
  const candidate = await tx.changeEvent.findFirst({
    where: { entityType, entityId, status: { in: [...MERGEABLE_STATUS] } },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  if (candidate) {
    await tx.changeEvent.update({
      where: { id: candidate.id },
      data: {
        version,
        op,
        status: "pending",
        nextRunAt: now,
        lastError: null,
        workerId: null,
      },
    });
    return { outcome: "merged", eventId: candidate.id };
  }

  // 2) 无可吸收行（无事件，或仅 processing/done）：插新 pending 行。id 走 cuid 默认。
  const created = await tx.changeEvent.create({
    data: {
      entityType,
      entityId,
      workspaceId,
      version,
      op,
      status: "pending",
      nextRunAt: now,
    },
    select: { id: true },
  });
  return { outcome: "inserted", eventId: created.id };
}

/**
 * 批量登记（同一事务内多实体，如表删除级联记录）。逐条调用合并原语，
 * 保证每条各自走"先 update 后 insert"去重；返回逐条结果，顺序与入参一致。
 */
export async function enqueueChangeEventsTx(
  tx: DbTx,
  inputs: readonly EnqueueChangeInput[],
): Promise<EnqueueChangeResult[]> {
  const out: EnqueueChangeResult[] = [];
  for (const input of inputs) {
    out.push(await enqueueChangeEventTx(tx, input));
  }
  return out;
}
