// M3/S3 路由层同步测试共享夹具（真库真 16 迁移 + 真 HTTP，复用 S0 charHarness）。
//
// 提供：
//  - 失败注入（裁决 9 双向回滚证明）：用 SQLite trigger 让 nav_nodes 写全部 ABORT（方向①：
//    nav 失败 -> 实体写整体回滚），或让指定实体表写 ABORT（方向②：实体失败 -> nav 无残留/不变）；
//  - assertNoDiffs：操作后 reconcile computeDiffs 的阻断差异 A+B+C 全 0（C1S soft_dangling 为 warning 不计）；
//  - 常用造数（直接 prisma 建实体 + sync，模拟"接线前已存在"的干净起点）。

import { setupCharHarness, json, type CharHarness } from "./characterization/charHarness.js";
import { computeDiffs } from "../reconcile.js";
// 注意：不能在模块顶层静态 import ../sync.js —— sync -> guards -> db 会在 vitest 收集期
// （beforeAll 注入临时 __gx_prisma 之前）就求值 db.ts 单例，导致 app 连到错误的库（401）。
// reconcile 链只 type-import DbTx，不拉 db 运行时，可静态引用；sync 改为用时动态 import。

export type { CharHarness };
export { setupCharHarness, json };

export async function makeNavHarness(label?: string): Promise<CharHarness> {
  return setupCharHarness(label);
}

// ---- 失败注入 trigger（操作前 CREATE，操作后务必 stopFailing，trigger 不随事务回滚）----

function triggerSql(table: string, op: "INSERT" | "UPDATE" | "DELETE", name: string): string {
  return `CREATE TEMP TRIGGER ${name} BEFORE ${op} ON ${table}
    BEGIN SELECT RAISE(ABORT, 'injected failure on ${table} ${op}'); END;`;
}

/** 让所有 nav_nodes 写（INSERT/UPDATE/DELETE）失败：验证 nav 失败 -> 实体写整体回滚。 */
export async function failNavWrites(h: CharHarness): Promise<void> {
  await h.prisma.$executeRawUnsafe(triggerSql("nav_nodes", "INSERT", "trg_fail_nav_ins"));
  await h.prisma.$executeRawUnsafe(triggerSql("nav_nodes", "UPDATE", "trg_fail_nav_upd"));
  await h.prisma.$executeRawUnsafe(triggerSql("nav_nodes", "DELETE", "trg_fail_nav_del"));
}

/** 让指定实体表的指定写失败：验证实体失败 -> nav 无残留/未变（同事务回滚）。 */
export async function failEntityWrite(
  h: CharHarness,
  table: string,
  op: "INSERT" | "UPDATE" | "DELETE",
): Promise<void> {
  await h.prisma.$executeRawUnsafe(triggerSql(table, op, `trg_fail_${table}_${op}`));
}

export async function stopFailing(h: CharHarness): Promise<void> {
  for (const n of ["trg_fail_nav_ins", "trg_fail_nav_upd", "trg_fail_nav_del"]) {
    await h.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${n}`).catch(() => undefined);
  }
  const rows = await h.prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name LIKE 'trg_fail_%'",
  );
  for (const r of rows) {
    await h.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${r.name}`).catch(() => undefined);
  }
}

/** 断言当前库无阻断性 A/B/C 差异（C1S soft_dangling 为 warning，不计）。 */
export async function assertNoBlockingDiffs(h: CharHarness): Promise<void> {
  const report = await h.prisma.$transaction((tx) => computeDiffs(tx));
  const blocking = [...report.A, ...report.B, ...report.C];
  if (blocking.length > 0) {
    throw new Error(`存在阻断差异:\n${blocking.map((d) => `[${d.code}] ${d.message} ${d.ref ?? ""}`).join("\n")}`);
  }
}

/** 直接造一个活 base + starter table + grid view 并同步 nav（不经 HTTP）。 */
export async function seedBaseWithStarter(
  h: CharHarness,
  p: string,
): Promise<{ baseId: string; tableId: string; viewId: string }> {
  const baseId = `${p}_b`;
  const tableId = `${p}_t`;
  const viewId = `${p}_v`;
  await h.prisma.$transaction([
    h.prisma.base.create({ data: { id: baseId, name: `${p} base`, createdBy: "owner" } }),
    h.prisma.member.create({ data: { id: `${p}_m`, baseId, userId: "owner", role: "owner" } }),
    h.prisma.table.create({ data: { id: tableId, baseId, name: "starter", primaryFieldId: "", createdBy: "owner" } }),
    h.prisma.view.create({ data: { id: viewId, tableId, name: "grid", type: "grid", order: 0, config: "{}" } }),
  ]);
  const { syncNavFromEntitiesTx } = await import("../sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  return { baseId, tableId, viewId };
}

/** 直接造一个活 kb + 根 doc + 子 doc + canvas 并同步 nav（不经 HTTP）。 */
export async function seedKbWithDocs(
  h: CharHarness,
  p: string,
): Promise<{ kbId: string; rootDoc: string; childDoc: string; canvas: string }> {
  const kbId = `${p}_kb`;
  const rootDoc = `${p}_d1`;
  const childDoc = `${p}_d2`;
  const canvas = `${p}_c1`;
  await h.prisma.$transaction([
    h.prisma.knowledgeBase.create({ data: { id: kbId, name: `${p} kb`, createdBy: "owner" } }),
    h.prisma.kbMember.create({ data: { id: `${p}_km`, kbId, userId: "owner", role: "owner" } }),
    h.prisma.kbDoc.create({ data: { id: rootDoc, kbId, kind: "doc", title: "root", content: "", createdBy: "owner", updatedBy: "owner" } }),
    h.prisma.kbDoc.create({ data: { id: childDoc, kbId, kind: "doc", title: "child", content: "", parentId: rootDoc, createdBy: "owner", updatedBy: "owner" } }),
    h.prisma.kbDoc.create({ data: { id: canvas, kbId, kind: "canvas", title: "canvas", content: "[]", createdBy: "owner", updatedBy: "owner" } }),
  ]);
  const { syncNavFromEntitiesTx } = await import("../sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  return { kbId, rootDoc, childDoc, canvas };
}
