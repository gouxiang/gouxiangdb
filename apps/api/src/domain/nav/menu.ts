// M3/S6 菜单编排写：PATCH /api/v1/workspaces/current/menu 的批量 diff 单事务应用。
//
// 纪律（计划 §4.5/§5.4/ADR-0025）：
//  - 整批一个事务，全成功或 4xx 全拒；只写 menu_items + bump menuVersion，
//    绝不写 nav_nodes/navVersion，绝不自动收纳实体；
//  - 容器嵌套硬上限 2 层；shortcut 不能作为父；容器父链防环；
//  - shortcut.nodeId 必须指向活 nav_nodes 行（新增指向软删节点无业务意义，拒绝）；
//  - iconName 必须在 NAV_ICONS 白名单（单一真源在 shared-types）；
//  - delete 为软删：容器软删时应用层 DFS 级联软删全部后代（DB 级联只对物理删生效）。

import crypto from "node:crypto";
import type { MenuOp } from "@gx/shared-types";
import { NAV_ICONS } from "@gx/shared-types";
import type { DbTx } from "../../db.js";
import { HttpError } from "../../guards.js";
import { WS_ID } from "./backfill.js";

/** 菜单容器嵌套层级硬上限（一级容器 depth=1）。 */
const MENU_MAX_DEPTH = 2;
const LABEL_MAX = 120;
const ICONS = new Set<string>(NAV_ICONS);

interface MenuRowLite {
  id: string; parentId: string | null; type: string; nodeId: string | null;
  label: string | null; iconName: string | null; ord: number; deletedAt: Date | null;
}

function bad(message: string, code = "BAD_REQUEST"): HttpError {
  return new HttpError(400, message, code);
}

/** candidateParentId 是否为容器自身或其后代（挂下去即成环）。 */
function isSelfOrDescendant(containerId: string, candidateParentId: string, byId: Map<string, MenuRowLite>): boolean {
  let cur: string | null = candidateParentId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === containerId) return true;
    if (seen.has(cur)) return false; // 既有环交由 containerDepth 报告
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

/** 沿 parentId 向上求容器链深度（一级=1）；遇 shortcut 父/断链/环抛 400。 */
function containerDepth(
  parentId: string | null,
  byId: Map<string, MenuRowLite>,
  seen: Set<string> = new Set(),
): number {
  if (parentId === null) return 0;
  if (seen.has(parentId)) throw bad("菜单容器成环", "NAV_CYCLE");
  const parent = byId.get(parentId);
  if (!parent || parent.deletedAt || parent.type !== "container") {
    throw bad("父菜单项必须是活容器");
  }
  const next = new Set(seen);
  next.add(parentId);
  return containerDepth(parent.parentId, byId, next) + 1;
}

function assertLabel(label: unknown): string | null {
  if (label === null || label === undefined) return null;
  if (typeof label !== "string") throw bad("label 必须是字符串或 null");
  const t = label.trim();
  if (t.length > LABEL_MAX) throw bad(`别名不能超过 ${LABEL_MAX} 字`);
  return t.length ? t : null;
}

function assertIcon(iconName: unknown): string | null {
  if (iconName === null || iconName === undefined || iconName === "") return null;
  if (typeof iconName !== "string" || !ICONS.has(iconName)) {
    throw bad(`iconName 不在白名单（NAV_ICONS）: ${iconName}`);
  }
  return iconName;
}

function assertOrd(ord: unknown): number {
  if (ord === undefined) return 0;
  if (typeof ord !== "number" || !Number.isInteger(ord)) throw bad("ord 必须是整数");
  return ord;
}

async function assertLiveNode(tx: DbTx, nodeId: string): Promise<void> {
  const node = await tx.navNode.findFirst({ where: { id: nodeId, deletedAt: null }, select: { id: true } });
  if (!node) throw new HttpError(409, `shortcut 指向的节点不存在或已软删: ${nodeId}`, "NAV_RESOURCE_MISSING");
}

/** 收集某容器全部后代 id（DFS，沿 parentId）。 */
function collectDescendants(rootId: string, rows: MenuRowLite[]): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.parentId) continue;
    const arr = childrenOf.get(r.parentId) ?? [];
    arr.push(r.id);
    childrenOf.set(r.parentId, arr);
  }
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const child of childrenOf.get(cur) ?? []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

async function bumpMenuVersionTx(tx: DbTx): Promise<number> {
  const ws = await tx.workspace.update({
    where: { id: WS_ID },
    data: { menuVersion: { increment: 1 } },
    select: { menuVersion: true },
  });
  return ws.menuVersion;
}

/**
 * shortcut 行写入的唯一真源：活节点守卫 → label/icon/ord 白名单断言 → 单行 create。
 *
 * 两处共用入口（禁止在别处再写一份 tx.menuItem.create 的 shortcut 插入）：
 *   - applyMenuChangesTx 的 insert 分支（PATCH menu 的批量操作）；
 *   - 建库/建知识库「自动入导航」（第三批导航重构已下线——一级导航改为直接读实体列表，
 *     原 ensureEntityShortcutTx 随之删除，此处不再有第二个调用点）。
 * 刻意不 bump menuVersion：由调用方在其事务边界内决定，避免同事务重复自增。
 */
async function createShortcutRowTx(
  tx: DbTx,
  input: {
    id: string;
    parentId: string | null;
    nodeId: string;
    label?: string | null;
    iconName?: string | null;
    ord?: number;
  },
): Promise<MenuRowLite> {
  // 守卫先于断言：坏 nodeId 必须报 409，不能被 label/icon 的 400 抢先。
  await assertLiveNode(tx, input.nodeId);
  const label = assertLabel(input.label);
  const iconName = assertIcon(input.iconName);
  const ord = assertOrd(input.ord);
  const created = await tx.menuItem.create({
    data: {
      id: input.id, workspaceId: WS_ID, parentId: input.parentId, type: "shortcut",
      nodeId: input.nodeId, label, iconName, ord,
    },
  });
  return {
    id: created.id, parentId: created.parentId, type: created.type, nodeId: created.nodeId,
    label: created.label, iconName: created.iconName, ord: created.ord, deletedAt: null,
  };
}

/**
 * 批量应用菜单操作。返回新 menuVersion 与各项 id（与 ops 顺序对齐，非 insert 回原 id）。
 * 顺序执行各 op 的校验与写，任何一步抛错整事务回滚（调用方包 withWriteTx）。
 */
export async function applyMenuChangesTx(
  tx: DbTx,
  ops: readonly MenuOp[],
): Promise<{ menuVersion: number; itemIds: string[] }> {
  const all = await tx.menuItem.findMany();
  const byId = new Map<string, MenuRowLite>();
  for (const r of all) if (!r.deletedAt) byId.set(r.id, r);
  const liveRow = (id: string): MenuRowLite => {
    const row = byId.get(id);
    if (!row) throw bad(`菜单项不存在或已删除: ${id}`);
    return row;
  };

  const itemIds: string[] = [];
  for (const op of ops) {
    if (op.op === "insert") {
      const type = op.type;
      if (type !== "container" && type !== "shortcut") throw bad("type 只能是 container 或 shortcut");
      const parentId = op.parentId ?? null;
      if (parentId !== null) {
        const parent = liveRow(parentId);
        if (parent.type !== "container") throw bad("shortcut 不能作为父菜单项");
      }
      const parentDepth = containerDepth(parentId, byId);
      const nodeId = op.nodeId ?? null;
      // 仅 shortcut 带 nodeId；这里先取一份收窄值，供下面走 shortcut 写入真源时用。
      const shortcutNodeId = type === "shortcut" ? nodeId : null;
      if (type === "shortcut" && !shortcutNodeId) throw bad("shortcut 必须带 nodeId");
      if (type !== "shortcut" && nodeId !== null) throw bad("container 不能带 nodeId");
      // 容器自身将落在 parentDepth+1 层；shortcut 不占容器层级但仍须父为容器。
      if (type === "container" && parentDepth + 1 > MENU_MAX_DEPTH) {
        throw bad(`容器嵌套不能超过 ${MENU_MAX_DEPTH} 层`, "NAV_MENU_DEPTH");
      }
      const id = op.id && /^[A-Za-z0-9_-]{1,64}$/.test(op.id) ? op.id : `menu_${crypto.randomBytes(12).toString("hex")}`;
      if (byId.has(id)) throw bad(`菜单项 id 已存在: ${id}`);
      if (shortcutNodeId) {
        // 活节点守卫（409）与 label/icon/ord 白名单断言都在 createShortcutRowTx 内，
        // 与「建库自动入导航」共用同一条写入路径，此处不再另写插入。
        const row = await createShortcutRowTx(tx, {
          id, parentId, nodeId: shortcutNodeId,
          label: op.label, iconName: op.iconName, ord: op.ord,
        });
        byId.set(row.id, row);
        itemIds.push(row.id);
        continue;
      }
      const created = await tx.menuItem.create({
        data: {
          id, workspaceId: WS_ID, parentId, type, nodeId: null,
          label: assertLabel(op.label), iconName: assertIcon(op.iconName), ord: assertOrd(op.ord),
        },
      });
      byId.set(created.id, {
        id: created.id, parentId: created.parentId, type: created.type, nodeId: created.nodeId,
        label: created.label, iconName: created.iconName, ord: created.ord, deletedAt: null,
      });
      itemIds.push(created.id);
      continue;
    }

    if (op.op === "update") {
      const row = liveRow(op.id);
      const data: { label?: string | null; iconName?: string | null } = {};
      if (op.label !== undefined) data.label = assertLabel(op.label);
      if (op.iconName !== undefined) data.iconName = assertIcon(op.iconName);
      if (Object.keys(data).length === 0) throw bad("update 至少要带 label 或 iconName");
      await tx.menuItem.update({ where: { id: row.id }, data });
      itemIds.push(row.id);
      continue;
    }

    if (op.op === "reorder") {
      const row = liveRow(op.id);
      const ord = assertOrd(op.ord);
      let parentId = row.parentId;
      if (op.parentId !== undefined) {
        const target = op.parentId;
        if (target !== null) {
          const tp = liveRow(target);
          if (tp.type !== "container") throw bad("shortcut 不能作为父菜单项");
        }
        if (row.type === "container") {
          if (target === row.id) throw bad("容器不能挂到自身下", "NAV_CYCLE");
          if (target !== null && isSelfOrDescendant(row.id, target, byId)) {
            throw bad("容器不能挂到自身子孙下", "NAV_CYCLE");
          }
          // 换父后容器层级仍须 <=2；把自身临时从图中摘除后计算目标深度。
          const savedParent = row.parentId;
          row.parentId = target;
          try {
            if (containerDepth(target, byId) + 1 > MENU_MAX_DEPTH) {
              throw bad(`容器嵌套不能超过 ${MENU_MAX_DEPTH} 层`, "NAV_MENU_DEPTH");
            }
          } finally {
            row.parentId = savedParent;
          }
        }
        parentId = target;
      }
      await tx.menuItem.update({ where: { id: row.id }, data: { ord, parentId } });
      row.ord = ord;
      row.parentId = parentId;
      itemIds.push(row.id);
      continue;
    }

    // delete：软删自身 + 全部后代（容器删除级联；shortcut 无后代）。
    const row = liveRow(op.id);
    const victimIds = [row.id, ...collectDescendants(row.id, [...byId.values()])];
    const now = new Date();
    for (const id of victimIds) {
      await tx.menuItem.update({ where: { id }, data: { deletedAt: now } });
      byId.delete(id);
    }
    itemIds.push(row.id);
  }

  const menuVersion = await bumpMenuVersionTx(tx);
  return { menuVersion, itemIds };
}
