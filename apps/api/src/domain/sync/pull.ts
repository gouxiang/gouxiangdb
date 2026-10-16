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
import { TREE_WORKSPACE_ID, readTreeVersion } from "./treeOplog.js";
import { TREE_ENTITY_TYPES } from "./navRegistry.js";

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
    // YN7 结构轨（table/field/view）：结构 op 不含记录行明文（只含字段/视图元数据），且每个订阅
    // 该 base 的端都必须收到结构时钟滴答，否则其本地 schemaVersion 与服务端分叉、无法正确计算数据
    // op 的 baseSchemaVersion（§19.2）。本函数调用方（路由）已过 base enter；结构 op 即对 base
    // 内所有订阅端下发，payload 原样透传（结构可见性＝进得去库即可见库结构，与导航树同口径）。
    if (row.entityType === "table" || row.entityType === "field" || row.entityType === "view") {
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
        payload: safeParsePayload(row.payload),
        result: row.result,
        conflictOf: row.conflictOf,
        createdAt: row.createdAt.toISOString(),
      });
      continue;
    }

    // YN2 记录轨：逐表按当前 r/行/字段权限裁剪；其它实体类型（nav 随 YN8、doc 走协同轨）跳过。
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

// ─────────────────── YN8：工作区导航树（navnode）游标增量拉取 ───────────────────

export interface TreePullPage {
  scope: "workspace_tree";
  scopeId: string;
  ops: PullOp[];
  /** 本页最后一条 seq；无数据时回显 after。 */
  nextCursor: string;
  hasMore: boolean;
  /** 当前工作区 treeVersion（钟值）；客户端据此判断本地树是否落后。 */
  treeVersion: string;
  authzVersion: number;
}

/**
 * 拉取工作区导航树在游标 after 之后的增量 op（baseId 恒 null 的 navnode op）。
 *
 * 权限口径（读，区别于 push 的 manage_menu）：同步总门 + requireActiveUser 已保证是登录成员。
 * 树是跨库工作区资源、不隶属任何 base，故【不过 base 库门】，也不做记录轨那种逐表 r/行/字段裁剪：
 *   - nav op 的 payload 只含导航结构元数据（节点 id/父子/ord/分组名/删除策略），无任何记录行/文档明文；
 *   - 回放（尤其 nav_reorder 的 orderedIds 强集合）要求兄弟集合完整，逐条按资源可见性裁剪会让离线端
 *     集合对不上而无法重放；结构 op 下发同此理（见 pullBaseOps 结构轨注释）。
 * 因此登录成员即可拉全树结构增量，与在线 GET /workspaces/current/tree「登录即可见树骨架」一致。
 *
 * @param clientId 订阅方实例；用于推进 scopeType=workspace_tree 订阅游标（记账，不参与授权）。
 * @param after    上次收到的最大 seq（seq keyset，不信客户端时钟），从其后一条开始。
 * @param limit    本页最多 op 数（默认 500，硬上限 2000）。
 */
export async function pullTreeOps(
  clientId: string | null,
  after: bigint,
  limit = 500,
): Promise<TreePullPage> {
  const max = Math.max(1, Math.min(limit, 2000));

  // 树 op：baseId 恒 null、entityType∈注册表树实体集（本期仅 navnode）。多取 1 条判 hasMore。
  const rows = await prisma.syncOpLog.findMany({
    where: {
      baseId: null,
      entityType: { in: [...TREE_ENTITY_TYPES] },
      seq: { gt: after },
    },
    orderBy: { seq: "asc" },
    take: max + 1,
  });
  const hasMore = rows.length > max;
  const page = hasMore ? rows.slice(0, max) : rows;

  const ops: PullOp[] = page.map((row) => ({
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
    payload: safeParsePayloadAny(row.payload),
    result: row.result,
    conflictOf: row.conflictOf,
    createdAt: row.createdAt.toISOString(),
  }));

  const nextCursor = page.length > 0 ? page[page.length - 1]!.seq : after;
  const [treeVersion, authzVersion] = await Promise.all([
    readTreeVersion(TREE_WORKSPACE_ID),
    readPolicyVersion(),
  ]);

  // 记账：推进工作区树订阅游标（与 pushTreeOps 的游标推进同一 scope，pull/push 双向都不回拉自己）。
  if (clientId && page.length > 0) {
    await prisma.syncSubscription.updateMany({
      where: { clientId, scopeType: "workspace_tree", scopeId: TREE_WORKSPACE_ID },
      data: { cursorSeq: nextCursor, snapshotDone: true, lastPullAt: new Date() },
    });
  }

  return {
    scope: "workspace_tree",
    scopeId: TREE_WORKSPACE_ID,
    ops,
    nextCursor: nextCursor.toString(),
    hasMore,
    treeVersion: treeVersion.toString(),
    authzVersion,
  };
}

async function readPolicyVersion(): Promise<number> {
  const ws = await prisma.workspace.findUnique({
    where: { id: WORKSPACE_ID },
    select: { policyVersion: true },
  });
  return ws?.policyVersion ?? 0;
}

/** 树 op payload 不做字段裁剪：原样 JSON 解析（损坏回退 {}，不让整次 pull 失败）。 */
function safeParsePayloadAny(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function safeParsePayload(raw: string): { tableId?: unknown } {
  try {
    return JSON.parse(raw) as { tableId?: unknown };
  } catch {
    return {};
  }
}
