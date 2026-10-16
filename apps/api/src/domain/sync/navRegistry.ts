// YN8 离线同步：导航树（navnode）op 注册表 —— §20.1 的落地件（树轨，与 YN7 表结构注册表并列）。
//
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md
//   §19.1（nav op 词表：nav_create_group/nav_rename/nav_move/nav_reorder/nav_delete）、
//   §19.6（treeVersion 工作区级结构钟；path/depth 服务端重算、防环；同节点/同兄弟分叉人工选）、
//   §19.3-7（自动节点只由服务端 reconcile 派生，这里绝不登记"建资源节点"op）、
//   §19.4（导航分组/移动/改名/删除复用现有 manage_menu 管理判定，非 manage_schema）、
//   §20.1（引擎只认注册表，不堆模块 if）、§20.4（同串行队列/同事务）、§8.4（保留离线 cuid）。
//
// 与 structureRegistry.ts 的区别（故单立一表，不混装）：
//   - 钟：树 op 推进工作区单钟 workspace_tree:ws_default（treeOplog.writeTreeOpTx），结构 op 推进
//     每表 table_schema:<tableId>；
//   - 权限：树 op 一律组织动作 manage_menu（工作区级），结构 op 是 base/table 节点的 manage_schema；
//   - 分片：树 op 的 sync_op_log.baseId 恒 null（独立 scopeType="workspace_tree" 订阅/拉取）。
//
// 引擎纪律：push 回放引擎对树 op 的全部了解就是「entityType:op 查本表 → assert → apply」。
// 路径重算/防环/深度/删除策略全部复用 domain/nav 现有 *Tx 原语，本文件不开第二套树写路径。

import type { DbTx } from "../../db.js";
import { HttpError } from "../../httpError.js";
import type { GroupDeleteStrategy } from "@gx/shared-types";
import { createGroupTx, updateGroupTx, deleteGroupTx } from "../nav/groups.js";
import { moveNodeTx, reorderNavSiblingsTx } from "../nav/move.js";
// 仅类型引用（编译期擦除）：注册表与 push 引擎互相 import 不产生运行时循环。
import type { IncomingOp } from "./push.js";
import type { TreeEntityType } from "./treeOplog.js";

const MALFORMED = "SYNC_MALFORMED_PAYLOAD";

/**
 * 离线分组 id 护栏（与 createGroupTx 的显式-id 白名单同口径）：会拼进物化路径，
 * 只允许 cuid 风格安全字符、8–64 位。回放时客户端给了 id 却不合规必须【明确拒绝】，
 * 绝不能让底层静默换成随机 navgrp_ id——否则后续引用该 id 的 op 会集体失联且客户端永无对账依据。
 */
const OFFLINE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
/** 导航父位哨兵："" / "root" 都表示根层（与 nodes 路由 normalizeParent 同口径）。 */
function normalizeParent(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return "__invalid__";
  const t = v.trim();
  return t === "" || t === "root" ? null : t;
}

export interface TreeApplyOutcome {
  entityType: TreeEntityType;
  /** oplog 实体 id（reorder 取父位标识；其余=被操作节点/新分组 id）。 */
  entityId: string;
  /** 写入 oplog 的规范化 op 名。 */
  op: string;
  /** 随 oplog 下发的结构化 payload（只含导航结构元数据，无记录/文档明文）。 */
  payload: Record<string, unknown>;
}

export interface TreeOpHandler {
  entityType: TreeEntityType;
  /** 写前纯读校验（payload 结构/目标存在性）；非法抛 HttpError 4xx。权限由引擎统一判，不在此。 */
  assertTx: (tx: DbTx, o: IncomingOp) => Promise<void>;
  /** 在回放事务内应用树主写（复用 domain/nav 的 *Tx 原语）；不得自行开事务/入写队列。 */
  applyTx: (tx: DbTx, userId: string, o: IncomingOp) => Promise<TreeApplyOutcome>;
}

// ───────────────────────── nav_create_group ─────────────────────────

const createGroupHandler: TreeOpHandler = {
  entityType: "navnode",
  async assertTx(tx, o) {
    const p = asRecord(o.payload) ?? {};
    if (!OFFLINE_ID_RE.test(o.entityId)) {
      throw new HttpError(400, "nav_create_group 实体 id 非法（需 8–64 位字母/数字/_/-）", MALFORMED);
    }
    if (!str(p.name)) throw new HttpError(400, "nav_create_group 缺少 name", MALFORMED);
    const parent = normalizeParent(p.parentId);
    if (parent === "__invalid__") throw new HttpError(400, "nav_create_group parentId 非法", MALFORMED);
    if (parent) {
      const row = await tx.navNode.findFirst({ where: { id: parent, deletedAt: null }, select: { kind: true } });
      if (!row || row.kind !== "group") throw new HttpError(400, "分组只能挂在另一个分组下", MALFORMED);
    }
    if (p.ord !== undefined && (typeof p.ord !== "number" || !Number.isInteger(p.ord))) {
      throw new HttpError(400, "ord 必须是整数", MALFORMED);
    }
  },
  async applyTx(_tx, _userId, o) {
    const p = asRecord(o.payload) ?? {};
    const parent = normalizeParent(p.parentId);
    const id = await createGroupTx(_tx, {
      id: o.entityId, // 保留离线分组 cuid（§8.4）；createGroupTx 内做安全字符校验
      name: str(p.name) as string,
      ...(parent ? { parentId: parent } : {}),
      ...(typeof p.ord === "number" ? { ord: p.ord } : {}),
      ...(p.iconName !== undefined ? { iconName: str(p.iconName) } : {}),
    });
    return {
      entityType: "navnode", entityId: id, op: o.op,
      payload: { name: str(p.name), parentId: parent, ...(typeof p.ord === "number" ? { ord: p.ord } : {}) },
    };
  },
};

// ───────────────────────── nav_rename（仅分组；实体节点改名随实体 reconcile） ─────────────────────────

const renameGroupHandler: TreeOpHandler = {
  entityType: "navnode",
  async assertTx(tx, o) {
    const p = asRecord(o.payload) ?? {};
    if (!str(p.name)) throw new HttpError(400, "nav_rename 缺少 name", MALFORMED);
    const node = await tx.navNode.findFirst({
      where: { id: o.entityId, deletedAt: null }, select: { kind: true },
    });
    if (!node) throw new HttpError(404, "导航分组不存在或已删除", "SYNC_ENTITY_NOT_FOUND");
    if (node.kind !== "group") throw new HttpError(400, "nav_rename 仅作用于手动分组（实体节点改名请改对应实体）", MALFORMED);
  },
  async applyTx(tx, _userId, o) {
    const p = asRecord(o.payload) ?? {};
    await updateGroupTx(tx, o.entityId, { name: str(p.name) as string });
    return { entityType: "navnode", entityId: o.entityId, op: o.op, payload: { name: str(p.name) } };
  },
};

// ───────────────────────── nav_move（任意活节点；path/depth/防环服务端重算） ─────────────────────────

const moveNodeHandler: TreeOpHandler = {
  entityType: "navnode",
  async assertTx(tx, o) {
    const p = asRecord(o.payload) ?? {};
    // to.parentId 为权威目标父；兼容 toParentId 平铺。
    const to = asRecord(p.to);
    const rawParent = to ? to.parentId : p.toParentId;
    const parent = normalizeParent(rawParent);
    if (parent === "__invalid__") throw new HttpError(400, "nav_move 目标父非法（移到根层用 root）", MALFORMED);
    const node = await tx.navNode.findFirst({
      where: { id: o.entityId, deletedAt: null }, select: { kind: true, parentId: true },
    });
    if (!node) throw new HttpError(404, "导航节点不存在或已删除", "SYNC_ENTITY_NOT_FOUND");
    // 实体节点不能移到根层（与 resolveMoveTargets 同规则，提前给明确 4xx）。
    if (parent === null && node.kind !== "group") {
      throw new HttpError(400, "实体节点不能移到根层，只能移动到分组下", MALFORMED);
    }
    if (to && to.ord !== undefined && (typeof to.ord !== "number" || !Number.isInteger(to.ord))) {
      throw new HttpError(400, "移动落位 ord 必须是整数", MALFORMED);
    }
  },
  async applyTx(tx, _userId, o) {
    const p = asRecord(o.payload) ?? {};
    const to = asRecord(p.to);
    const parent = normalizeParent(to ? to.parentId : p.toParentId);
    const ord = to && typeof to.ord === "number" ? to.ord : undefined;
    // moveNodeTx 内做最终防环/深度/目标父校验 + 子树 path/depth 重写（§19.6 服务端是唯一裁判）。
    await moveNodeTx(tx, o.entityId, parent, ord);
    return {
      entityType: "navnode", entityId: o.entityId, op: o.op,
      payload: { to: { parentId: parent, ...(ord !== undefined ? { ord } : {}) } },
    };
  },
};

// ───────────────────────── nav_reorder（同父兄弟集合重排） ─────────────────────────

const reorderHandler: TreeOpHandler = {
  entityType: "navnode",
  async assertTx(tx, o) {
    const p = asRecord(o.payload) ?? {};
    const parent = normalizeParent(p.parentId);
    if (parent === "__invalid__") throw new HttpError(400, "nav_reorder parentId 非法", MALFORMED);
    if (parent) {
      const row = await tx.navNode.findFirst({ where: { id: parent, deletedAt: null }, select: { kind: true } });
      if (!row || row.kind !== "group") throw new HttpError(400, "只能对某分组下（或根层）的兄弟排序", MALFORMED);
    }
    if (!Array.isArray(p.orderedIds)) throw new HttpError(400, "nav_reorder 缺少 orderedIds 数组", MALFORMED);
  },
  async applyTx(tx, _userId, o) {
    const p = asRecord(o.payload) ?? {};
    const parent = normalizeParent(p.parentId);
    const orderedIds = (p.orderedIds as unknown[]).map((x) => (typeof x === "string" ? x : "")).filter(Boolean);
    await reorderNavSiblingsTx(tx, parent, orderedIds);
    // entityId 取父位标识（根层用 "root"），便于 oplog 按作用点索引。
    return {
      entityType: "navnode", entityId: parent ?? "root", op: o.op,
      payload: { parentId: parent, orderedIds },
    };
  },
};

// ───────────────────────── nav_delete（仅手动分组；资源节点删除走实体回收站） ─────────────────────────

const deleteGroupHandler: TreeOpHandler = {
  entityType: "navnode",
  async assertTx(tx, o) {
    const node = await tx.navNode.findFirst({
      where: { id: o.entityId, deletedAt: null }, select: { kind: true },
    });
    if (!node) throw new HttpError(404, "导航分组不存在或已删除", "SYNC_ENTITY_NOT_FOUND");
    if (node.kind !== "group") throw new HttpError(400, "nav_delete 仅作用于手动分组（删除库/表/文档请用对应回收站）", MALFORMED);
    const p = asRecord(o.payload) ?? {};
    if (p.strategy !== undefined && p.strategy !== "move" && p.strategy !== "retain") {
      throw new HttpError(400, "strategy 只能是 move 或 retain", MALFORMED);
    }
  },
  async applyTx(tx, _userId, o) {
    const p = asRecord(o.payload) ?? {};
    const strategy = p.strategy === "move" || p.strategy === "retain"
      ? (p.strategy as GroupDeleteStrategy)
      : undefined;
    const target = normalizeParent(p.targetParentId);
    const r = await deleteGroupTx(tx, o.entityId, strategy, target === "__invalid__" ? null : target);
    return {
      entityType: "navnode", entityId: o.entityId, op: o.op,
      payload: { ...(strategy ? { strategy } : {}), ...(target && target !== "__invalid__" ? { targetParentId: target } : {}), moved: r.moved },
    };
  },
};

// ───────────────────────── 注册表本体（引擎只认它） ─────────────────────────

const REGISTRY = new Map<string, TreeOpHandler>([
  [`navnode:nav_create_group`, createGroupHandler],
  [`navnode:nav_rename`, renameGroupHandler],
  [`navnode:nav_move`, moveNodeHandler],
  [`navnode:nav_reorder`, reorderHandler],
  [`navnode:nav_delete`, deleteGroupHandler],
]);

export function treeRegistryKey(entityType: string, op: string): string {
  return `${entityType}:${op}`;
}

export function getTreeOpHandler(entityType: string, op: string): TreeOpHandler | null {
  return REGISTRY.get(treeRegistryKey(entityType, op)) ?? null;
}

/** 树轨支持的实体族（供 push 引擎区分树轨 vs 结构轨 vs 记录轨；menu_* 顺延后再登记）。 */
export const TREE_ENTITY_TYPES: ReadonlySet<string> = new Set(["navnode"]);

export function isTreeEntityType(entityType: string): boolean {
  return TREE_ENTITY_TYPES.has(entityType);
}
