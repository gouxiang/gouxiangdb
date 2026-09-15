// M3 nav 同步原语：实体写点在既有 withWriteTx/withWriteBatch 事务内调用（计划 §4.4，裁决 9）。
//
// 铁律：
//  - 每个原语只接收并使用传入 tx，回调内禁止再入队（M1 铁律）；
//  - 强一致：nav 写失败 -> 实体写整体回滚；实体写回滚 -> 不留半截节点。
//    禁止 try/catch 吞错降级 best-effort；异常原样透传，由事务边界统一回滚；
//  - 本文件只维护 nav_nodes（+workspaces.navVersion）；不写 menu_items（"menu 不动"）。
//    仅在物理删节点前【读】menu_items 做 RESTRICT 守卫；doc 永久删按 §4.4-13d 主动清自身 shortcut。
//  - path 是派生数据：创建/改名/移动/恢复后用 backfill 的期望集单一事实源对齐 + rebuildPathsTx；
//    软删走 path 前缀子树；M3 规模下全量对齐简单可靠，S10 再按 10 万节点做定向优化。

import type { DbTx } from "../../db.js";
import {
  buildExpectedNodes,
  reconcileNodesTx,
  rebuildPathsTx,
  nodeId,
  type NavKind,
} from "./backfill.js";

/**
 * 惰性抛 HttpError：不在本文件顶层 import guards.js（它会连带 db.ts 在模块加载期实例化
 * PrismaClient，破坏测试 harness 的 globalThis 注入）；HttpError 仅在真正越界时才需要。
 */
async function throwNodeInUse(message: string): Promise<never> {
  const { HttpError } = await import("../../guards.js");
  throw new HttpError(409, message);
}

/** nav_nodes 任意写入后推进工作区 nav 版本（M3 无消费者，为 M4/前端失效留口）。 */
export async function bumpNavVersionTx(tx: DbTx): Promise<void> {
  await tx.workspace.update({
    where: { id: "ws_default" },
    data: { navVersion: { increment: 1 } },
  });
}

/**
 * M4/S5：物理删节点时同事务清掉挂在这些节点上的 auth_policies。
 * auth_policies 对 nav_nodes【无外键】（DDL 刻意解耦，策略可先于/独立于节点写入），
 * 故物理删节点不会级联清策略，必须在 purge 原语内显式删，否则留下指向不存在节点的孤儿授权。
 * 直接经 tx 清（不经 authz/projection，避免 nav -> authz 反向依赖）；按节点 id 整行删，
 * 涵盖 direct/role/dept、legacy:* 与 policy:v1 全部来源（节点都没了，其授权无意义）。
 */
async function purgePoliciesForNodesTx(tx: DbTx, nodeIds: readonly string[]): Promise<void> {
  const ids = nodeIds.filter(Boolean);
  if (ids.length === 0) return;
  await tx.authPolicy.deleteMany({ where: { nodeId: { in: ids } } });
}

/**
 * 按当前实体状态全量对齐实体节点（缺建/异更/软删复活/parent-name-ord 修正）并重算 path，
 * 最后 bump navVersion。创建/改名/移动/恢复写点的统一入口——期望集只此一套（backfill）。
 * 不处理"实体已软删而节点活"（由 softDeleteSubtreeTx 显式软删）与物理删（purge 原语）。
 */
export async function syncNavFromEntitiesTx(tx: DbTx): Promise<void> {
  const expected = await buildExpectedNodes(tx);
  await reconcileNodesTx(tx, expected);
  await rebuildPathsTx(tx);
  await bumpNavVersionTx(tx);
}

/**
 * 软删某节点及其整棵 nav 子树。
 *
 * 实现沿 parentId 收集子树闭包（不依赖物化 path）：迁移 B 后非根节点 path 初始为空串，
 * 需部署后跑 reconcile --apply 才有值，故按 path 前缀会漏删；parentId 在回填时即完整。
 * 对 base：base -> tables -> views；对 kb：kb -> docs/canvas（含文档多级层级）。
 * 软删保留行与 path，恢复时由 syncNavFromEntitiesTx 复活并重算。
 */
export async function softDeleteSubtreeTx(tx: DbTx, rootNodeId: string): Promise<void> {
  const all = await tx.navNode.findMany({ select: { id: true, parentId: true } });
  const childrenOf = new Map<string, string[]>();
  for (const n of all) {
    if (!n.parentId) continue;
    const arr = childrenOf.get(n.parentId) ?? [];
    arr.push(n.id);
    childrenOf.set(n.parentId, arr);
  }
  if (!all.some((n) => n.id === rootNodeId)) return; // 节点缺失（异常库）由 reconcile 报 A1，软删幂等 no-op。
  const ids: string[] = [];
  const stack = [rootNodeId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    ids.push(cur);
    for (const child of childrenOf.get(cur) ?? []) stack.push(child);
  }
  const now = new Date();
  for (const id of ids) {
    await tx.navNode.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: now } });
  }
  await bumpNavVersionTx(tx);
}

/**
 * 定向对齐单个实体节点的 name/parentId/ord（改名、视图换序），不影响 path。
 * 供高频保存路径使用（如视图 PATCH 的 config-only 更新不得触发 nav 全量扫描）：
 * 仅当实体的 name/ord/parent 实际可能变化时调用。节点缺失则建活（含 path 重算）。
 * 返回是否发生写入（调用方无需关心，bump 已在内部按变化处理）。
 */
export async function alignResourceNodeTx(tx: DbTx, kind: NavKind, resourceId: string): Promise<void> {
  const expected = await buildExpectedNodes(tx);
  const e = expected.find((x) => x.kind === kind && x.resourceId === resourceId);
  if (!e) return; // 实体已不活（软删/消失）：由软删/purge/reconcile 路径处理，此处不写。
  const cur = await tx.navNode.findUnique({ where: { id: e.id } });
  if (!cur) {
    await reconcileNodesTx(tx, [e]);
    await rebuildPathsTx(tx);
    await bumpNavVersionTx(tx);
    return;
  }
  const changed = cur.name !== e.name || cur.parentId !== e.parentId || cur.ord !== e.ord ||
    cur.resourceType !== e.kind || cur.resourceId !== e.resourceId;
  if (changed || cur.deletedAt) {
    await tx.navNode.update({
      where: { id: e.id },
      data: { name: e.name, parentId: e.parentId, ord: e.ord, resourceType: e.kind, resourceId: e.resourceId, deletedAt: null },
    });
    if (cur.parentId !== e.parentId || cur.deletedAt) await rebuildPathsTx(tx);
    await bumpNavVersionTx(tx);
  }
}

/**
 * 仅软删单个节点（doc 软删不级联子文档——实体层 kbDoc 软删就是单条）。
 * 子节点的父改挂（父软删后活子 doc 回退挂 kb）由随后的 syncNavFromEntitiesTx 按期望集对齐。
 */
export async function softDeleteSingleNodeTx(tx: DbTx, kind: NavKind, resourceId: string): Promise<void> {
  const nid = nodeId(kind, resourceId);
  await tx.navNode.updateMany({ where: { id: nid, deletedAt: null }, data: { deletedAt: new Date() } });
  await bumpNavVersionTx(tx);
}

/** 物理删前的 RESTRICT 守卫：仍被任何 menu_items 行引用则 409（C-12：先清引用再删节点）。 */
async function assertNoMenuReferences(tx: DbTx, nodeIdValue: string): Promise<void> {
  const refs = await tx.menuItem.count({ where: { nodeId: nodeIdValue } });
  if (refs > 0) {
    // FK ON DELETE RESTRICT 不管软删标记，物理行即引用；编排"移除"必须是物理 DELETE（S6 注意）。
    await throwNodeInUse("该节点仍被导航菜单引用，请先移除菜单引用后再彻底删除");
  }
}

/**
 * 视图物理删（§4.4-10）：shortcut 守卫（默认不生成 view shortcut，此处为防御）+ 删节点。
 * view 是叶子（无 nav 子节点）。必须在实体 view 行删除的【同一事务内、实体删除前后均可】调用。
 */
export async function purgeViewNodeTx(tx: DbTx, viewId: string): Promise<void> {
  const nid = nodeId("view", viewId);
  await assertNoMenuReferences(tx, nid);
  await purgePoliciesForNodesTx(tx, [nid]); // M4/S5：view 无独立旧表，直接删挂在该 view 节点的策略
  await tx.navNode.deleteMany({ where: { id: nid } });
  await bumpNavVersionTx(tx);
}

/**
 * 表物理删（§4.4-15，回收站彻底删除）：
 *  - table 节点有任何菜单引用 -> 409（不静默级联删菜单，用户编排成果需显式移除）；
 *  - nav 层无跨表 FK，须先删 table 节点下的全部子节点（即 view 节点，含历史软删行），
 *    再删 table 节点本身（自引用 ON DELETE RESTRICT，必须先清子行，顺序无关实体删除先后）。
 */
export async function purgeTableNodeTx(tx: DbTx, tableId: string): Promise<void> {
  const tableNodeId = nodeId("table", tableId);
  await assertNoMenuReferences(tx, tableNodeId);
  // M4/S5：table 下子 view 节点随之物理删，先取其 id 连同 table 节点一并清策略。
  const childNodes = await tx.navNode.findMany({
    where: { parentId: tableNodeId },
    select: { id: true },
  });
  await purgePoliciesForNodesTx(tx, [tableNodeId, ...childNodes.map((n) => n.id)]);
  await tx.navNode.deleteMany({ where: { parentId: tableNodeId } });
  await tx.navNode.deleteMany({ where: { id: tableNodeId } });
  await bumpNavVersionTx(tx);
}

/**
 * 文档/画布永久删（§4.4-13d）：与 table 不同，doc 永久删是内容所有者操作，
 * 按计划主动物理清理指向该节点的 shortcut 行与节点本身（不返回 409）；
 * 孤儿子文档（实体 parentId 悬空但仍活）改挂 kb 由随后的 syncNavFromEntitiesTx 对齐。
 */
export async function purgeDocNodeTx(tx: DbTx, docId: string): Promise<void> {
  // doc 与 canvas 共用 kb_docs，按实际节点行判定其 kind。
  const node = await tx.navNode.findFirst({
    where: { resourceId: docId, resourceType: { in: ["doc", "canvas"] } },
    select: { id: true, parentId: true },
  });
  if (node) {
    await tx.menuItem.deleteMany({ where: { nodeId: node.id } }); // 先清引用（绕开 menu RESTRICT）
    // M4/S5：同事务清挂在该 doc/canvas 节点的全部 auth_policies（含 legacy:acl 与 v1/role/dept）。
    await purgePoliciesForNodesTx(tx, [node.id]);
    // 防御：调用方已先 sync 对齐活子节点；此处把任何残留 parentId（含软删行）顶到祖父，
    // 否则 nav_nodes 自引用 RESTRICT 会让删除失败。
    await tx.navNode.updateMany({ where: { parentId: node.id }, data: { parentId: node.parentId } });
    await tx.navNode.deleteMany({ where: { id: node.id } });
  }
  await bumpNavVersionTx(tx);
}
