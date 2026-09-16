// M4/S11 ADR-0034 存活断言：kb_member 单行投影（靠 nav 祖树继承）与逐 doc 物化
// 在 N>=4 层深文档树上逐节点逐动作全等（真库真迁移，不 mock）。
//
// 裁决 A-1 的证伪条件（ADR-0034 §3）：任一 kb_member 对 kb 下每个 doc/canvas 的
// decide(U,D,action) 必须与"在每个 D 上各写一行同动作 direct user 策略"的假想
// 逐 doc 物化判定全等；任一格分叉即回退逐 doc 物化并把 ADR-0034 置 Superseded。
//
// 本夹具物理对拍两种投影形态（同一棵树、同一批用户，仅切换 auth_policies 形态）：
//   态 A 生产形态：kb_members 投影到 kb 容器节点单行（legacy:kb_member），叶判定靠继承；
//   态 B 假想形态：删掉 kb 单行，同一成员授权在每个 doc/canvas 节点各写一行 direct。
// 两态分别跑引擎 decide 后逐格比较；若未来继承收集与逐 doc 物化真分叉，本文件变红。
//
// 深度模型事实（backfill.ts:78-81）：nav 中仅 doc 可经 parentId 嵌套，canvas 恒挂
// kb（kind!=doc 或父非活 doc 时回落 kb）。故深链 kb->F1->F2->F3->F4->D5 全部由
// doc 承担（最深 depth=5，满足下钻 >=4 层），canvas 以 depth1 叶覆盖第二种 kind。
// manage_schema 对 doc/canvas 非法（actionLegalForNode），动作集按 kind 取六枚。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResourceAction } from "@gx/shared-types";
import { makeNavHarness, type CharHarness } from "../../../domain/nav/__tests__/navRouteHarness.js";
import { nodeId } from "../../../domain/nav/backfill.js";
import { applyAuthzReconcileFixes } from "../reconcile.js";
import { LEGACY_REASONS, upsertByLegacyRow, type LegacyRow } from "../backfill.js";

const ACTIONS: readonly ResourceAction[] = ["r", "c", "u", "d", "comment", "manage_share"];
const KB = "s11eq_kb";
const KB_NODE = nodeId("kb", KB);
// doc 容器链 depth1..4 与各层内容叶 depth1..5；C1 为 depth1 canvas 叶。
const DOC_TREE: Array<{ id: string; title: string; parent: string | null }> = [
  { id: "s11eq_f1", title: "F1分组", parent: null },
  { id: "s11eq_f2", title: "F2子分组", parent: "s11eq_f1" },
  { id: "s11eq_f3", title: "F3子分组", parent: "s11eq_f2" },
  { id: "s11eq_f4", title: "F4子分组", parent: "s11eq_f3" },
  { id: "s11eq_l1", title: "L1层文档", parent: null },
  { id: "s11eq_l2", title: "L2层文档", parent: "s11eq_f1" },
  { id: "s11eq_l3", title: "L3层文档", parent: "s11eq_f2" },
  { id: "s11eq_d4", title: "D4深层文档", parent: "s11eq_f3" },
  { id: "s11eq_d5", title: "D5最深文档", parent: "s11eq_f4" },
];
const CANVAS_IDS = ["s11eq_c1"];
const DEEPEST_DOC = "s11eq_d5";

const UV = "s11eq_viewer"; // kb viewer 成员
const UE = "s11eq_editor"; // kb editor 成员
const UOUT = "s11eq_stranger"; // 非成员
const UACL = "s11eq_aclonly"; // 仅对 D5 有 direct kb_doc_acls 例外
const MEMBERS: Array<{ user: string; role: "viewer" | "editor" }> = [
  { user: UV, role: "viewer" },
  { user: UE, role: "editor" },
];

interface Leaf {
  nodeId: string;
  kind: "doc" | "canvas";
  resourceId: string;
  depth: number;
}

let h: CharHarness;
let engineDecideResource: typeof import("../adapter.js").engineDecideResource;
let leaves: Leaf[] = [];

async function decide(user: string, leaf: Leaf, action: ResourceAction): Promise<boolean> {
  const { engineAllowed } = await engineDecideResource(
    user,
    { resourceType: leaf.kind, resourceId: leaf.resourceId },
    action,
    h.prisma,
  );
  return engineAllowed;
}

/** 对给定成员集在全部 doc/canvas 节点 x 六动作上跑 decide，返 "node|action" -> bool。 */
async function snapshot(users: readonly string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (const user of users) {
    for (const leaf of leaves) {
      for (const action of ACTIONS) {
        out.set(`${user}|${leaf.nodeId}|${action}`, await decide(user, leaf, action));
      }
    }
  }
  return out;
}

/** 态 B：删 kb 容器单行投影，在每个内容节点写成员档位同动作集的 direct 物化行。 */
async function materializePerDoc(): Promise<void> {
  await h.prisma.authPolicy.deleteMany({
    where: { reason: LEGACY_REASONS.kbMember, nodeId: KB_NODE },
  });
  type PolicyCreate = Parameters<typeof h.prisma.authPolicy.create>[0]["data"];
  const rows: PolicyCreate[] = [];
  for (const leaf of leaves) {
    for (const m of MEMBERS) {
      rows.push({
        id: `s11eq_mat_${m.user}_${leaf.resourceId}`,
        workspaceId: "ws_default",
        nodeId: leaf.nodeId,
        subjectType: "user",
        subjectId: m.user,
        actions: m.role === "editor" ? "r,c,u,d,comment" : "r",
        reason: "policy:v1",
        createdBy: "s11-test",
      });
    }
  }
  await h.prisma.authPolicy.createMany({ data: rows });
}

/** 回到态 A：删逐 doc 物化行，按 kb_members 权威行 upsert 回 kb 容器单行投影。 */
async function restoreSingleRow(): Promise<void> {
  await h.prisma.authPolicy.deleteMany({ where: { id: { startsWith: "s11eq_mat_" } } });
  for (const m of MEMBERS) {
    const row: LegacyRow = {
      oldId: `s11eq_km_${m.role[0]}`,
      nodeId: KB_NODE,
      userId: m.user,
      role: m.role,
      reason: LEGACY_REASONS.kbMember,
      family: "kb",
    };
    await upsertByLegacyRow(h.prisma, row);
  }
}

beforeAll(async () => {
  h = await makeNavHarness("gx-m4-s11-kbeq-");
  await h.createUser("owner", { email: "owner@s11eq.x", displayName: "所有者" });
  for (const u of [UV, UE, UOUT, UACL]) {
    await h.createUser(u, { email: `${u}@s11eq.x`, displayName: u });
  }
  await h.prisma.roleAssignment.create({
    data: { roleId: "role_owner", subjectType: "user", subjectId: "owner", scopeType: "workspace", createdBy: "seed" },
  });
  await h.prisma.knowledgeBase.create({ data: { id: KB, name: "s11 深树库", createdBy: "owner" } });
  await h.prisma.kbMember.create({ data: { id: "s11eq_km_o", kbId: KB, userId: "owner", role: "owner" } });
  await h.prisma.kbMember.create({ data: { id: "s11eq_km_v", kbId: KB, userId: UV, role: "viewer" } });
  await h.prisma.kbMember.create({ data: { id: "s11eq_km_e", kbId: KB, userId: UE, role: "editor" } });
  const statements = [
    ...DOC_TREE.map((d) => h.prisma.kbDoc.create({
      data: {
        id: d.id, kbId: KB, kind: "doc", title: d.title, content: "",
        parentId: d.parent, createdBy: "owner", updatedBy: "owner",
      },
    })),
    ...CANVAS_IDS.map((id) => h.prisma.kbDoc.create({
      data: { id, kbId: KB, kind: "canvas", title: "C1画布", content: "[]", createdBy: "owner", updatedBy: "owner" },
    })),
  ];
  await h.prisma.$transaction(statements);
  const { syncNavFromEntitiesTx } = await import("../../nav/sync.js");
  await h.prisma.$transaction((tx) => syncNavFromEntitiesTx(tx));
  // 旧三表 -> auth_policies 投影（生产回填路径，禁止测试内手搓 kb 投影动作串）。
  await applyAuthzReconcileFixes(h.prisma);

  const navRows = await h.prisma.navNode.findMany({
    where: { resourceType: { in: ["doc", "canvas"] }, deletedAt: null },
    select: { id: true, resourceType: true, resourceId: true, depth: true },
  });
  leaves = navRows
    .map((r) => ({
      nodeId: r.id,
      kind: r.resourceType as "doc" | "canvas",
      resourceId: r.resourceId!,
      depth: r.depth,
    }))
    .sort((a, b) => (a.depth - b.depth) || a.nodeId.localeCompare(b.nodeId));

  // adapter 顶层静态 import db 单例，按 flip-drill 范式在 harness 注入后动态导入。
  ({ engineDecideResource } = await import("../adapter.js"));
}, 180000);

afterAll(async () => {
  await h.cleanup();
});

describe("夹具形状：N>=4 层深树、两 kind、每层有内容叶", () => {
  it("10 个内容节点（9 doc + 1 canvas），nav depth 含 kb 根（kb=1）：叶 depth 2..6 每层有叶，D5 depth=6（相对 kb 下钻 5 层，>=4）", () => {
    expect(leaves).toHaveLength(10);
    expect(leaves.filter((l) => l.kind === "doc")).toHaveLength(9);
    expect(leaves.filter((l) => l.kind === "canvas")).toHaveLength(1);
    const byDepth = new Map<number, Leaf[]>();
    for (const l of leaves) byDepth.set(l.depth, [...(byDepth.get(l.depth) ?? []), l]);
    for (const depth of [2, 3, 4, 5, 6]) {
      expect(byDepth.get(depth)?.length ?? 0, `depth ${depth} 应有内容叶`).toBeGreaterThan(0);
    }
    const deepest = leaves.filter((l) => l.resourceId === DEEPEST_DOC);
    expect(deepest).toHaveLength(1);
    expect(deepest[0]!.depth).toBe(6);
  });
});

describe("ADR-0034 存活断言：单行 kb 投影 vs 逐 doc 物化，120 格全等", () => {
  let phaseA: Map<string, boolean>;
  let phaseB: Map<string, boolean>;

  it("态 A 非平凡：viewer 仅 r、editor 五动作，allow/deny 格都存在", async () => {
    phaseA = await snapshot([UV, UE]);
    let allows = 0;
    for (const v of phaseA.values()) if (v) allows++;
    // viewer 10 格 r=10 allow；editor 10*5=50 allow；manage_share 两档皆 deny。
    expect(allows).toBe(60);
    expect(allows).toBeGreaterThan(0);
    expect(allows).toBeLessThan(2 * leaves.length * ACTIONS.length);
    for (const leaf of leaves) {
      expect(phaseA.get(`${UV}|${leaf.nodeId}|r`)).toBe(true);
      expect(phaseA.get(`${UV}|${leaf.nodeId}|manage_share`)).toBe(false);
      expect(phaseA.get(`${UE}|${leaf.nodeId}|comment`)).toBe(true);
      expect(phaseA.get(`${UE}|${leaf.nodeId}|manage_share`)).toBe(false);
    }
  });

  it("存活 sanity：人为切断 F2 继承后，其深层子孙 r 转 deny（证断言吃继承链，非常真）", async () => {
    const f2 = nodeId("doc", "s11eq_f2");
    const d5 = leaves.find((l) => l.resourceId === DEEPEST_DOC)!;
    const l1 = leaves.find((l) => l.resourceId === "s11eq_l1")!;
    await h.prisma.navNode.update({ where: { id: f2 }, data: { inheritAncestors: 0 } });
    // F2 子树在 F2 cutoff：kb 单行不被 D5 收集；挂 kb 的 depth1 叶不受影响。
    expect(await decide(UV, d5, "r")).toBe(false);
    expect(await decide(UE, d5, "comment")).toBe(false);
    expect(await decide(UV, l1, "r")).toBe(true);
    await h.prisma.navNode.update({ where: { id: f2 }, data: { inheritAncestors: 1 } });
    expect(await decide(UV, d5, "r")).toBe(true);
  });

  it("态 B（逐 doc 物化）与态 A 的 120 格逐格全等", async () => {
    await materializePerDoc();
    phaseB = await snapshot([UV, UE]);
    const mismatches: string[] = [];
    for (const [key, want] of phaseA) {
      const got = phaseB.get(key);
      if (got !== want) mismatches.push(`${key} singleRow=${want} perDoc=${got}`);
    }
    expect(mismatches, `分叉格:\n${mismatches.slice(0, 20).join("\n")}`).toEqual([]);
    await restoreSingleRow();
  });
});

describe("对照主体：非成员全 deny；direct ACL 例外仅被授叶 allow", () => {
  it("非成员对 10 节点 x 6 动作全部 deny", async () => {
    const denied: string[] = [];
    for (const leaf of leaves) {
      for (const action of ACTIONS) {
        if (await decide(UOUT, leaf, action)) denied.push(`${UOUT}@${leaf.nodeId}:${action}`);
      }
    }
    expect(denied, `非成员意外 allow:\n${denied.join("\n")}`).toEqual([]);
  });

  it("ACL 例外用户：仅最深 D5 持 editor 五动作；其余 9 节点（含同 depth 相邻）全 deny", async () => {
    await h.prisma.kbDocAcl.create({
      data: { id: "s11eq_acl_d5", docId: DEEPEST_DOC, userId: UACL, role: "editor" },
    });
    await applyAuthzReconcileFixes(h.prisma);
    const d5 = leaves.find((l) => l.resourceId === DEEPEST_DOC)!;
    for (const action of ["r", "c", "u", "d", "comment"] as const) {
      expect(await decide(UACL, d5, action)).toBe(true);
    }
    expect(await decide(UACL, d5, "manage_share")).toBe(false);
    const leaked: string[] = [];
    for (const leaf of leaves) {
      if (leaf.resourceId === DEEPEST_DOC) continue;
      for (const action of ACTIONS) {
        if (await decide(UACL, leaf, action)) leaked.push(`${UACL}@${leaf.nodeId}:${action}`);
      }
    }
    expect(leaked, `ACL 例外越出 D5:\n${leaked.join("\n")}`).toEqual([]);
  });
});
