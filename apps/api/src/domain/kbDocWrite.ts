// M6/S4 文档内容写服务（**从 routes/kb/docs.ts 原样移动** + 显式传参；team-lead 裁决 A）。
//
// 目的：REST（PUT /docs/:docId/content）与 MCP doc.* 写工具共用同一写实现，避免语义漂移。
// 纪律：事务边界 / 编排顺序 / 错误类型与文案 / 状态码 / 响应形状**一律不变**。
//   顺序：条件更新（乐观锁冲突 -> 抛 VersionConflictError）-> maybeAutoSnapshotTx -> outbox upsert -> nav sync。
//
// 迁移对照（原 routes/kb/docs.ts -> 本文件）：
//   VersionConflictError  routes/kb/shared.ts:34-38 -> 本文件（逐字搬）
//   saveDocContentTx      原 withWriteTx("doc.content.save") 回调体 190-222 -> 本文件（逐行搬，
//                         仅把闭包变量 doc.*/parsed.data.baseVersion/userId 改为显式参数）

import type { DbTx } from "../db.js";
import { HttpError } from "../guards.js";
import { maybeAutoSnapshotTx } from "./kb.js";
import type { ChangeEntityType } from "./search/outbox.js";
import { enqueueChangeEventTx } from "./search/outbox.js";
import { syncNavFromEntitiesTx } from "./nav/sync.js";

/** kind -> outbox 实体类型（**从 routes/kb/docs.ts:27 移动**，单一真源）。 */
export const changeEntityOfKind = (kind: string): ChangeEntityType => (kind === "canvas" ? "canvas" : "doc");

/** 乐观锁冲突（HTTP 409 + code VERSION_CONFLICT；**类名/码/文案逐字不变**）。 */
export class VersionConflictError extends HttpError {
  constructor(public currentVersion: number | null) {
    super(409, "文档已被他人修改，请刷新后重试");
  }
}

export interface SaveDocContentParams {
  docId: string;
  kind: string;
  /** 读取时的 contentVersion（用于 outbox version 兜底）。 */
  currentVersion: number;
  content: string;
  searchText: string;
  userId: string;
  title?: string;
  /** 客户端携带的乐观锁版本；undefined = 旧客户端 last-write-wins。 */
  baseVersion?: number;
}

/** 保存文档正文（及可选 title）的事务体。 */
export async function saveDocContentTx(tx: DbTx, params: SaveDocContentParams): Promise<{ snapshotted: boolean; contentVersion: number | null }> {
      const data = {
        content: params.content,
        searchText: params.searchText,
        updatedBy: params.userId,
        contentVersion: { increment: 1 as const },
        ...(params.title ? { title: params.title } : {}),
      };
      if (params.baseVersion !== undefined) {
        // 条件更新：版本不匹配说明他人已保存，抛错回滚，由外层回 409 冲突信封
        const res = await tx.kbDoc.updateMany({
          where: { id: params.docId, contentVersion: params.baseVersion },
          data,
        });
        if (res.count === 0) {
          const cur = await tx.kbDoc.findUnique({ where: { id: params.docId }, select: { contentVersion: true } });
          throw new VersionConflictError(cur?.contentVersion ?? null);
        }
      } else {
        // 旧客户端（未携带版本）：保持 last-write-wins，但版本号照常递增
        await tx.kbDoc.update({ where: { id: params.docId }, data });
      }
      const snapshotted = await maybeAutoSnapshotTx(tx, params.docId, params.userId);
      const next = await tx.kbDoc.findUnique({ where: { id: params.docId }, select: { contentVersion: true, kind: true } });
      // M5/S1：正文（及附带 title）保存成功，两乐观锁分支汇流于此，发 upsert；
      // version 用递增后的 contentVersion（worker 据此对齐内容版本）。
      await enqueueChangeEventTx(tx, {
        entityType: changeEntityOfKind(next?.kind ?? params.kind),
        entityId: params.docId,
        op: "upsert",
        version: BigInt(next?.contentVersion ?? params.currentVersion + 1),
      });
      await syncNavFromEntitiesTx(tx);
      return { snapshotted, contentVersion: next?.contentVersion ?? null };
}
