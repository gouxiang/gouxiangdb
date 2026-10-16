// YN8 导航树冲突分析（§19.6）：treeVersion 分叉时，判定一条入站 nav op 与分叉期间服务端已接受的
// nav op 是「互不相交（自动合并）」还是「抢同一节点/同一组兄弟（树冲突，人工选）」。
//
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md §19.6：
//   - 双方移动【互不相交子树】→ 自动接受（服务端重排 ord、重算 path）；
//   - 移动【同一节点到不同父级】、或对【同一组兄弟】排序且 treeVersion 分叉 → 树冲突，弹窗二选一
//     （或拖到第三位置＝resolve mine 强制落位）；
//   - 被移动节点的资源/目标父离线期间被删 → ENTITY_DELETED 树冲突。
//
// 判定口径（本期保守：拿不准就交人工，绝不静默覆盖他人改动）：
//   每条 nav op 归约为「触及节点集 nodes」+「触及兄弟作用域 scopes（父位 id，根层为 null）」；
//   入站 op 与任一分叉 op 在 nodes 上相交（同节点被双方结构性改动）、或在 scopes 上相交（同一组兄弟
//   的成员/顺序被双方改动）→ 树冲突；否则视为不相交 → 调用方可跳过版本断言、以【当前树】自动重放。
//   入站引用的节点/目标父在当前树已不存在 → ENTITY_DELETED（优先级最高）。
//
// 本文件为纯读 + 纯函数，不开 open 事务、不写库；由 push.ts 在回放事务内调用。

import type { DbTx } from "../../db.js";
import type { IncomingOp } from "./push.js";

/** 树冲突原因码（push.ts 的 RC 里单点定义字符串，这里只做同值常量避免循环依赖）。 */
export const RC_TREE_CONFLICT = "SYNC_TREE_VERSION_CONFLICT";
export const RC_TREE_ENTITY_DELETED = "SYNC_ENTITY_DELETED";

/** 分叉期间一条已接受（含 resolved）的 nav op 的分析视图（取自 sync_op_log）。 */
export interface ForkOp {
  op: string;
  entityId: string;
  payload: Record<string, unknown>;
  actorId: string | null;
  clientId: string;
  seq: bigint;
}

export interface TreeConflict {
  reasonCode: typeof RC_TREE_CONFLICT | typeof RC_TREE_ENTITY_DELETED;
  /** 机器可读冲突类别，供弹窗选择文案/形态。 */
  kind: "node_move" | "sibling_order" | "node_rename" | "group_delete" | "entity_deleted";
  /** 人类可读说明（不含敏感明文，只含导航结构信息）。 */
  detail: string;
  /** 与之相撞的分叉 op（最多回带若干条，供弹窗展示「服务端/对方的目标位置」）。 */
  competing: ForkOp[];
  /** 入站 op 引用但当前树已不存在的节点 id（entity_deleted 时）。 */
  missingNodeId?: string;
}

export type TreeConflictVerdict = { auto: true } | { auto: false; conflict: TreeConflict };

// ───────────────────────── payload 取值小工具 ─────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function parentOf(v: unknown): string | null | "__invalid__" {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return "__invalid__";
  const t = v.trim();
  return t === "" || t === "root" ? null : t;
}

/** move op 的 to.parentId（nav_move 的权威目标父）。 */
function moveTargetParent(p: Record<string, unknown>): string | null {
  const to = asRecord(p.to);
  const raw = to ? to.parentId : p.toParentId;
  const parent = parentOf(raw);
  return parent === "__invalid__" ? null : parent;
}

// ───────────────────────── 作用域/节点归约 ─────────────────────────

interface Touch {
  /** 该 op 结构性改动的节点 id（被移动/改名/删除/新建的节点）。 */
  nodes: Set<string>;
  /** 该 op 改动了兄弟集合成员或顺序的父位（null＝根层）。 */
  scopes: Set<string | null>;
}

function touchOf(op: string, entityId: string, payload: Record<string, unknown>): Touch {
  const nodes = new Set<string>();
  const scopes = new Set<string | null>();
  switch (op) {
    case "nav_move": {
      // 移动 Y：被移节点 Y 被结构性改动；源父与目标父两组兄弟都受影响。
      nodes.add(entityId);
      const from = asRecord(payload.from);
      const src = parentOf(from ? from.parentId : payload.fromParentId);
      if (src !== "__invalid__") scopes.add(src);
      scopes.add(moveTargetParent(payload));
      break;
    }
    case "nav_reorder": {
      const p = parentOf(payload.parentId);
      scopes.add(p === "__invalid__" ? null : p);
      break;
    }
    case "nav_create_group": {
      // 新建组 G：只新增节点 G。两个互不相关的新建（不同 id）即 §19.6「互不相交」，即便挂同一父位也
      // 自动合并（只增成员、不改既有节点/顺序），故不占兄弟作用域。与他人 move/reorder/delete 的撞车
      // 由下面的 nodes 交集或 ENTITY_DELETED 兜住。
      nodes.add(entityId);
      break;
    }
    case "nav_rename": {
      // 改名只动节点本身，不改兄弟集成员/顺序。
      nodes.add(entityId);
      break;
    }
    case "nav_delete": {
      // 删组 G：G 消失；按策略其直接孩子被移到目标父(move)/父位(retain)，作用域随之变化。
      nodes.add(entityId);
      scopes.add(entityId); // 该组自身的兄弟作用域消失
      const target = parentOf(payload.targetParentId);
      if (payload.strategy === "move" && target !== "__invalid__" && target !== null) scopes.add(target);
      // retain 回落到各实体默认父/被删组父位，可能跨多个作用域 → 保守起见用 null(根) 不足表达，
      // 冲突判定主要靠 nodes 交集（入站若移动/重排涉及被删组的子孙节点必在 nodes 上交集）。
      break;
    }
    default:
      break;
  }
  return { nodes, scopes };
}

/**
 * 读分叉期间（treeVersion > clientBaseVersion）【其它端】已接受/已解决的 nav op，按 seq 升序。
 * 关键：排除当前 clientId 自己的 op——同批/连续推送时本端前一条已 accepted 的 op 是客户端已知的
 * 因果前序（其本地 treeVersion 已随之推演），不算「他人分叉」，否则会把自己的连续改动误判成冲突。
 */
export async function readForkTreeOpsTx(
  tx: DbTx,
  clientBaseVersion: bigint,
  excludeClientId: string,
): Promise<ForkOp[]> {
  // 每条 accepted/resolved 的树 op 落库时 newVersion＝写入后的树版本；只取真正推进过树的结果，
  // newVersion > 客户端基线且来自别的设备，即「分叉期间他人已落地」的滴答。seq 全局单调即因果序。
  const rows = await tx.syncOpLog.findMany({
    where: {
      entityType: "navnode",
      result: { in: ["accepted", "resolved"] },
      newVersion: { gt: clientBaseVersion },
      clientId: { not: excludeClientId },
    },
    orderBy: { seq: "asc" },
    select: { op: true, entityId: true, payload: true, actorId: true, clientId: true, seq: true },
  });
  const out: ForkOp[] = [];
  for (const r of rows) {
    let parsed: Record<string, unknown> = {};
    try {
      const v: unknown = JSON.parse(r.payload);
      if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    out.push({ op: r.op, entityId: r.entityId, payload: parsed, actorId: r.actorId, clientId: r.clientId, seq: r.seq });
  }
  return out;
}

function setIntersects<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * 分析入站树 op 在当前分叉下可否自动合并。
 *
 * @param currentLiveIds 当前树【存活】节点 id 集（调用方一次查全表传入，避免本函数反复查库）。
 * @returns auto=true（不相交，调用方应以当前版本为断言基线重放）；auto=false 带冲突详情。
 */
export function analyzeTreeFork(
  o: IncomingOp,
  fork: readonly ForkOp[],
  currentLiveIds: ReadonlySet<string>,
): TreeConflictVerdict {
  const payload = asRecord(o.payload) ?? {};

  // ① ENTITY_DELETED 最优先：入站引用的【已存在】目标节点或目标父当前已不在活树。
  //    注意 nav_create_group 的 entityId 是【待建新 id】，本就不在活树，不能据此判失效；只验其父。
  const referenced: string[] = [];
  if (o.op !== "nav_create_group") referenced.push(o.entityId);
  if (o.op === "nav_move") {
    const parent = moveTargetParent(payload);
    if (parent) referenced.push(parent);
  } else if (o.op === "nav_create_group") {
    const p = parentOf(payload.parentId);
    if (p !== "__invalid__" && p !== null) referenced.push(p);
  }
  for (const id of referenced) {
    if (!currentLiveIds.has(id)) {
      return {
        auto: false,
        conflict: {
          reasonCode: RC_TREE_ENTITY_DELETED,
          kind: "entity_deleted",
          detail: "导航节点或其目标分组在离线期间已被删除；可移除该失效节点，或先恢复对应分组后重试",
          competing: [],
          missingNodeId: id,
        },
      };
    }
  }

  // ② 无分叉（基线＝当前）→ 直接走正常乐观锁，无需自动合并判定（交回外层以客户端基线断言）。
  if (fork.length === 0) return { auto: true };

  const mine = touchOf(o.op, o.entityId, payload);
  const competing: ForkOp[] = [];

  for (const f of fork) {
    const theirs = touchOf(f.op, f.entityId, f.payload);

    // 同节点被双方结构性改动。
    if (setIntersects(mine.nodes, theirs.nodes)) {
      // move-move 同节点：仅当目标父【相同】时结果趋同可自动；不同父＝§19.6 树冲突。
      if (o.op === "nav_move" && f.op === "nav_move" && o.entityId === f.entityId) {
        const myParent = moveTargetParent(payload);
        const theirParent = moveTargetParent(f.payload);
        if (myParent === theirParent) continue; // 目标一致，不冲突
      }
      competing.push(f);
      continue;
    }
    // 同一组兄弟的成员/顺序被双方改动。
    if (setIntersects(mine.scopes, theirs.scopes)) {
      // rename 不占作用域，不会走到这；create/move/reorder/delete 改动同组兄弟 → §19.6 兄弟冲突。
      competing.push(f);
    }
  }

  if (competing.length === 0) return { auto: true };

  const kind: TreeConflict["kind"] =
    o.op === "nav_move" ? "node_move"
    : o.op === "nav_reorder" ? "sibling_order"
    : o.op === "nav_rename" ? "node_rename"
    : o.op === "nav_delete" ? "group_delete"
    : "sibling_order";

  const detail =
    kind === "node_move"
      ? "同一节点在离线期间也被他人移动到了不同位置；请选择采用你的位置或服务端当前位置"
      : kind === "sibling_order"
        ? "同一组导航在离线期间也被他人调整过顺序或成员；请选择采用你的排列或服务端当前排列"
        : kind === "node_rename"
          ? "该分组在离线期间也被他人改名；请选择采用你的名称或服务端当前名称"
          : "该分组在离线期间其内容被他人调整，删除策略结果可能变化；请确认采用你的删除或保留服务端现状";

  return {
    auto: false,
    conflict: { reasonCode: RC_TREE_CONFLICT, kind, detail, competing: competing.slice(0, 5) },
  };
}

/**
 * 构建树冲突的服务端快照（conflictServerPayload，供弹窗展示「两个目标位置」）。
 * 只含导航结构元数据（节点 id/名/父/ord），无记录/文档明文；这是本人自己操作的冲突视图。
 */
export function buildTreeConflictPayload(
  o: IncomingOp,
  conflict: TreeConflict,
  currentVersion: bigint,
): Record<string, unknown> {
  return {
    kind: "tree",
    conflict: conflict.kind,
    reasonCode: conflict.reasonCode,
    detail: conflict.detail,
    clientBaseVersion: o.baseVersion.toString(),
    serverTreeVersion: currentVersion.toString(),
    incoming: {
      op: o.op,
      entityId: o.entityId,
      ...(asRecord(o.payload)?.to ? { to: (asRecord(o.payload) as Record<string, unknown>).to } : {}),
      ...(asRecord(o.payload)?.parentId !== undefined ? { parentId: (asRecord(o.payload) as Record<string, unknown>).parentId } : {}),
      ...(asRecord(o.payload)?.orderedIds ? { orderedIds: (asRecord(o.payload) as Record<string, unknown>).orderedIds } : {}),
      ...(asRecord(o.payload)?.name !== undefined ? { name: (asRecord(o.payload) as Record<string, unknown>).name } : {}),
    },
    competing: conflict.competing.map((f) => ({
      op: f.op,
      entityId: f.entityId,
      ...(f.payload.to ? { to: f.payload.to } : {}),
      ...(f.payload.parentId !== undefined ? { parentId: f.payload.parentId } : {}),
      actorId: f.actorId,
    })),
    ...(conflict.missingNodeId ? { missingNodeId: conflict.missingNodeId } : {}),
  };
}
