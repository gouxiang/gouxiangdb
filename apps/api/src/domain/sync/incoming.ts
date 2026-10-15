// YN5 同步中心：隔离/冲突/未生效改动的列表查询与显式放弃（只读面 + 一条留痕状态机迁移）。
//
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md
//   §9.2（rejected「保留可查看的我的未生效改动直到用户确认」、quarantined 可重试/放弃）、
//   §13（GET /incoming?status=、POST /incoming/:id/discard）、§12（状态机：
//   quarantined/conflict → dropped 必须用户显式确认，绝不静默丢）。
//
// 边界：
//   - 只允许操作【本人 actorId】的 sync_incoming 行；别人的项一律按 404 处理（不泄露存在性）。
//   - 重试（retryIncoming）在 push.ts——它要复用 push 的当前权限重放全套，强耦合故放那边。
//   - 本文件只做列表与放弃；冲突的"接受服务端/合并"属 YN6 resolve，不在此处理。
//   - 全程只改 sync_incoming 自身状态，绝不碰主数据/oplog/版本。

import { prisma } from "../../db.js";
import { HttpError } from "../../httpError.js";

/** 同步中心默认展示的"待处理"状态（accepted/dropped 是终态，不出现在待办里）。 */
const PENDING_STATUSES = ["quarantined", "conflict", "rejected", "pending_approval"] as const;

/** 可被显式放弃（→ dropped）的状态：隔离项、未生效改动、冲突项；accepted/dropped 不可放弃。 */
const DISCARDABLE_STATUSES = new Set(["quarantined", "rejected", "conflict", "pending_approval"]);

/** 列表项（payload 解析回对象，供同步中心展示"我当时改了什么"；这是本人自己的操作，回传本人）。 */
export interface IncomingItem {
  id: string;
  clientOpId: string;
  baseId: string | null;
  entityType: string;
  entityId: string;
  op: string;
  payload: Record<string, unknown>;
  baseVersion: string;
  status: string;
  reasonCode: string | null;
  reasonDetail: string | null;
  serverVersion: string;
  attempts: number;
  createdAt: string;
  decidedAt: string | null;
}

export interface IncomingList {
  items: IncomingItem[];
  /** 本次返回条数（客户端按需要再分页/按 base 过滤）。 */
  count: number;
}

/** 状态白名单校验（sync_incoming.status 在 DB 无 CHECK 约束，查询侧自行收紧，拒绝任意串）。 */
function normalizeStatusFilter(raw: string | null): string[] {
  if (!raw) return [...PENDING_STATUSES];
  const wanted = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const allowed = new Set([...PENDING_STATUSES, "accepted", "dropped", "received"]);
  for (const s of wanted) {
    if (!allowed.has(s)) {
      throw new HttpError(400, `不支持的 status 过滤值：${s}`, "SYNC_BAD_REQUEST");
    }
  }
  return wanted.length > 0 ? wanted : [...PENDING_STATUSES];
}

/**
 * 列出当前用户在同步中心的待处理项（只看本人 actorId）。
 * @param statusCsv 逗号分隔状态白名单；缺省＝待处理四态。
 * @param baseId 可选，仅看某 base。
 * @param limit 上限（默认 200，硬顶 1000，超大库保护）。
 */
export async function listIncoming(
  userId: string,
  opts: { statusCsv?: string | null; baseId?: string | null; limit?: number } = {},
): Promise<IncomingList> {
  const statuses = normalizeStatusFilter(opts.statusCsv ?? null);
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  const baseId = opts.baseId?.trim() || null;

  const rows = await prisma.syncIncoming.findMany({
    where: {
      actorId: userId,
      status: { in: statuses },
      ...(baseId ? { baseId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: limit,
  });

  const items: IncomingItem[] = rows.map((row) => {
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(row.payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = {};
    }
    return {
      id: row.id,
      clientOpId: row.clientOpId,
      baseId: row.baseId,
      entityType: row.entityType,
      entityId: row.entityId,
      op: row.op,
      payload,
      baseVersion: row.baseVersion.toString(),
      status: row.status,
      reasonCode: row.reasonCode,
      reasonDetail: row.reasonDetail,
      serverVersion: row.serverVersion.toString(),
      attempts: row.attempts,
      createdAt: row.createdAt.toISOString(),
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    };
  });

  return { items, count: items.length };
}

export interface DiscardResult {
  id: string;
  clientOpId: string;
  /** 迁移后的状态，恒为 dropped。 */
  status: "dropped";
}

/**
 * 显式放弃一条隔离/未生效/冲突项 → status=dropped（留痕，绝不删除行、绝不静默丢，§9.2/§12）。
 * 仅本人、且状态可放弃时生效；accepted/dropped/不存在/别人的项分别 404/409。
 * 要求 confirm=true（防误触，§13 req {confirm:true}）。
 */
export async function discardIncoming(
  userId: string,
  incomingId: string,
  confirm: boolean,
): Promise<DiscardResult> {
  if (confirm !== true) {
    throw new HttpError(400, "放弃操作需显式确认（confirm=true）", "SYNC_BAD_REQUEST");
  }
  const row = await prisma.syncIncoming.findUnique({
    where: { id: incomingId },
    select: { id: true, clientOpId: true, actorId: true, status: true },
  });
  if (!row || row.actorId !== userId) {
    throw new HttpError(404, "待处理项不存在", "SYNC_INCOMING_NOT_FOUND");
  }
  if (row.status === "dropped") {
    // 已放弃幂等：回同一结果，不重复写 decidedAt。
    return { id: row.id, clientOpId: row.clientOpId, status: "dropped" };
  }
  if (row.status === "accepted") {
    throw new HttpError(409, "该操作已生效，不能放弃（如需撤销请在数据表中删除/修改）", "SYNC_INCOMING_INVALID_STATE");
  }
  if (!DISCARDABLE_STATUSES.has(row.status)) {
    throw new HttpError(409, `当前状态为 ${row.status}，不能放弃`, "SYNC_INCOMING_INVALID_STATE");
  }

  // 条件更新双保险（owner + 可放弃状态），并发下只可能有一方成功。
  const upd = await prisma.syncIncoming.updateMany({
    where: { id: incomingId, actorId: userId, status: { in: [...DISCARDABLE_STATUSES] } },
    data: { status: "dropped", decidedBy: userId, decidedAt: new Date() },
  });
  if (upd.count === 0) {
    throw new HttpError(409, "待处理项状态已变化，请刷新后重试", "SYNC_INCOMING_INVALID_STATE");
  }
  return { id: row.id, clientOpId: row.clientOpId, status: "dropped" };
}
