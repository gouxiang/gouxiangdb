// YN2b 离线同步：pull 游标增量（subscribe 之后按 seq keyset 拉 oplog）+ 当前权限二次过滤。
//
// 设计权威：DESIGN-OFFLINE-SYNC §6（pull/权限/墓碑）、§8.3（seq keyset，不信客户端时钟）、
// §9.1/§9.3（按当前权限重判、降权不下发）、§13、§15.2（YN2）。
//
// 与 snapshot 同源：本文件复用 snapshot.ts 导出的 buildTableVisibility，逐表得到该主体
// 【此刻】的行可见 id 集与可见字段集——与在线列表/基线快照同一套 fieldScope + mask +
// queryRecords(rowFilter) 管线，杜绝 pull 与列表口径漂移（§20.1 注册表式复用，不另写裁决）。
//
// 过滤规则（每次 pull 实时重算，不因「订过」放宽，§6.2）：
//   - 表级完全不可见（cap.visible=false）   → 该表所有 op 不下发；
//   - create/update/patch/restore 非墓碑 op → 实体当前必须仍在行可见集内（行条件失配不下发），
//     且 payload.changes 只保留当前可见字段（被收回的字段不泄）；
//   - delete 墓碑                            → 不要求行仍可见（行已软删、必然不在可见集），
//     只要表仍可读即下发，保证客户端能把本地副本删掉（§6.4）。

import type { LibraryAccessDTO } from "@gx/shared-types";
import { prisma } from "../../db.js";
import { buildTableVisibility, visibleIdSet, type TableVisibility } from "./snapshot.js";

const WORKSPACE_ID = "ws_default";

export interface PullOp {
  seq: string;
  baseId: string | null;
  entityType: string;
  entityId: string;
  op: string;
  actorId: string | null;
  clientId: string;
  clientOpId: string;
  baseVersion: string;
  newVersion: string;
  /** 已按当前字段权限裁剪后的 payload（字段级 diff 只含可见字段；结构不变）。 */
  payload: unknown;
  result: string;
  conflictOf: string | null;
  createdAt: string;
}

export interface PullPage {
  baseId: string;
  ops: PullOp[];
  /** 本页最后一条（即服务端已让客户端看到的）seq；无数据时回显 after。 */
  nextCursor: string;
  /** 是否还有后续（服务端是否存在 seq 更大的同 base op）。 */
  hasMore: boolean;
  /** 当前权限版本（workspaces.policyVersion）；变化时客户端应做可见集对账（§6.3）。 */
  authzVersion: number;
}

/** 从 oplog payload 里剥掉当前不可见字段的 changes（create/update 通用）。 */
function maskPayload(raw: string, visibleFieldIds: Set<string> | null): unknown {
  let parsed: { changes?: unknown };
  try {
    parsed = JSON.parse(raw) as { changes?: unknown };
  } catch {
    // payload 损坏不应导致整次 pull 失败：原样返回字符串（保守，调用方可据需要再处理）。
    return raw;
  }
  if (!Array.isArray(parsed.changes) || visibleFieldIds === null) return parsed;
  parsed.changes = parsed.changes.filter(
    (ch) => !!ch && typeof ch === "object" && visibleFieldIds.has((ch as { fieldId?: unknown }).fieldId as string),
  );
  return parsed;
}

/**
 * 拉取某 base 在游标 after 之后的增量 oplog，按调用者【当前】权限逐条过滤。
 *
 * @param clientId 订阅方实例；用于推进 sync_subscription.cursorSeq（记账，不参与授权）。
 * @param baseId   订阅 base
 * @param after    上次收到的最大 seq（字符串/数字/大整数均可），从其后一条开始
 * @param limit    本页最多 op 数（默认 500，硬上限 2000）
 */
export async function pullBaseOps(
  userId: string,
  access: LibraryAccessDTO,
  clientId: string | null,
  baseId: string,
  after: bigint,
  limit = 500,
): Promise<PullPage> {
  const max = Math.max(1, Math.min(limit, 2000));

  // 多取 1 条判断 hasMore（keyset，不用 OFFSET/时间戳）。
  const rows = await prisma.syncOpLog.findMany({
    where: { baseId, seq: { gt: after } },
    orderBy: { seq: "asc" },
    take: max + 1,
  });
  const hasMore = rows.length > max;
  const page = hasMore ? rows.slice(0, max) : rows;

  // 单 pull 内逐表缓存可见性（同一表多条 op 只算一次；idSet 也只建一次）。
  interface CachedVis { vis: TableVisibility; ids: Set<string>; }
  const visCache = new Map<string, Promise<CachedVis | null>>();
  const visFor = (tableId: string): Promise<CachedVis | null> => {
    let p = visCache.get(tableId);
    if (!p) {
      p = buildTableVisibility(userId, access, tableId)
        .then((vis) => ({ vis, ids: visibleIdSet(vis) }))
        .catch(() => null);
      visCache.set(tableId, p);
    }
    return p;
  };

  const ops: PullOp[] = [];
  for (const row of page) {
    // YN2 只下发记录轨；其它实体类型（未来 doc/结构轨）出现时跳过，不猜测其可见性。
    if (row.entityType !== "record") continue;

    const payloadObj = safeParsePayload(row.payload) as { tableId?: unknown };
    const tableId = typeof payloadObj.tableId === "string" ? payloadObj.tableId : "";
    if (!tableId) continue;
    const cached = await visFor(tableId);
    // 表级不可见（含裁决异常 fail-closed → null）：不下发任何该表 op。
    if (!cached || !cached.vis.tableReadable) continue;

    const isDelete = row.op === "delete";
    if (!isDelete) {
      // 非墓碑：实体当前必须仍在行可见集内（行条件失配/已被移出可见集 → 不下发）。
      if (!cached.ids.has(row.entityId)) continue;
    }
    // delete：表可读即下发（行已软删、不在可见集是预期），让客户端删本地副本。

    ops.push({
      seq: row.seq.toString(),
      baseId: row.baseId,
      entityType: row.entityType,
      entityId: row.entityId,
      op: row.op,
      actorId: row.actorId,
      clientId: row.clientId,
      clientOpId: row.clientOpId,
      baseVersion: row.baseVersion.toString(),
      newVersion: row.newVersion.toString(),
      payload: maskPayload(row.payload, cached.vis.visibleFieldIds),
      result: row.result,
      conflictOf: row.conflictOf,
      createdAt: row.createdAt.toISOString(),
    });
  }

  const nextCursor = page.length > 0 ? page[page.length - 1]!.seq : after;
  const authzVersion = await readPolicyVersion();

  // 记账：推进订阅游标到「服务端已让其看到的最后 seq」（即便其中有权重过滤掉的行，
  // 游标也前进——那些行本就不该再因游标停留而被反复评估）。
  if (clientId && page.length > 0) {
    await prisma.syncSubscription.updateMany({
      where: { clientId, scopeType: "base", scopeId: baseId },
      data: { cursorSeq: nextCursor, snapshotDone: true, lastPullAt: new Date() },
    });
  }

  return { baseId, ops, nextCursor: nextCursor.toString(), hasMore, authzVersion };
}

async function readPolicyVersion(): Promise<number> {
  const ws = await prisma.workspace.findUnique({
    where: { id: WORKSPACE_ID },
    select: { policyVersion: true },
  });
  return ws?.policyVersion ?? 0;
}

function safeParsePayload(raw: string): { tableId?: unknown } {
  try {
    return JSON.parse(raw) as { tableId?: unknown };
  } catch {
    return {};
  }
}
