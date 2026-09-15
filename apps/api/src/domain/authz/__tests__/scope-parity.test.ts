// M4/S4 scope <-> decide 零分叉对拍 + 客体 SQL 计数（真迁移临时库，不经 HTTP）。
//
// 铁律（计划 §7-S4）：scope 快路径必须是逐节点 decide 的批量形态——本测试对夹具内【每一个活资源
// 节点】跑真实 engine.decide（适配器 makeCreatedByResolver 真点实体表），与 resolveVisibleNodeIds
// 的成员资格逐节点比对，r/u 两动作均要求 0 差异。夹具覆盖：
//   直接 user 授予 / role 授予（角色用户直挂）/ dept 部门授予 / 祖先继承 /
//   inheritAncestors=0 cutoff（边界节点自身策略被孙节点继承、对平级继承主体裁剪）/
//   creator 兜底（base/kb/doc/canvas/table 四实体表，且 creator 不沿导航树继承）/
//   workspace owner 全可见 / 无关系者全不可见 / table fieldMask 仅进 maskedTableFields 不影响节点可见。
//
// SQL 计数：客体批量（resolveSubject 主体定数之外）非 owner 恰 4 条：
//   authPolicy.findMany + navNode.findMany + $queryRawUnsafe(creator UNION) + workspace.findUnique；
// owner 跳过 creator UNION 为 3 条。与节点总数/部门深度无关。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  addDeptMembership,
  createDepts,
  createNavNodes,
  createPolicies,
  createRole,
  createUsers,
  assignRole,
  setupEngineHarness,
  type EngineHarness,
  type NodeSpec,
} from "./engineHarness.js";
import { resolveSubject } from "../subjects.js";
import { decide } from "../engine.js";
import { makeCreatedByResolver } from "../adapter.js";
import { resolveVisibleNodeIds, prepareScope, nodeVisibleInPrepared } from "../scope.js";
import type { AuthzClient, AuthzNode, ResolvedSubject } from "../types.js";

let h: EngineHarness;
let db: PrismaClient;

// 节点 id
const B = "sp_base";
const T = "sp_table";
const FT = "sp_ftable";
const DR = "sp_drdoc";
const L1 = "sp_l1";
const L1C = "sp_l1c";
const K = "sp_kb";
const D = "sp_doc";
const CV = "sp_canvas";

async function seed(): Promise<void> {
  await createUsers(db, [
    "u_own", "u_cr", "u_kbcr", "u_doccr", "u_tabcr",
    "u_view", "u_role", "u_dept", "u_l1", "u_kview", "u_mask", "u_out",
  ].map((id) => ({ id })));

  await createDepts(db, [{ id: "sp_D1", parentId: null, path: "/sp_D1/" }]);
  await addDeptMembership(db, [{ id: "sp_dm1", departmentId: "sp_D1", userId: "u_dept" }]);
  await createRole(db, { id: "sp_role_ru" });
  await assignRole(db, { roleId: "sp_role_ru", subjectType: "user", subjectId: "u_role" });
  await assignRole(db, { roleId: "role_owner", subjectType: "user", subjectId: "u_own" });

  // 真实体（createdBy 兜底 UNION 读这四张表）。
  await db.base.create({ data: { id: B, name: B, createdBy: "u_cr" } });
  await db.table.create({ data: { id: T, baseId: B, name: T, primaryFieldId: "pf_x", createdBy: "u_tabcr" } });
  await db.table.create({ data: { id: FT, baseId: B, name: FT, primaryFieldId: "pf_y", createdBy: "u_tabcr" } });
  await db.knowledgeBase.create({ data: { id: K, name: K, createdBy: "u_kbcr" } });
  await db.kbDoc.create({ data: { id: D, kbId: K, kind: "doc", title: D, createdBy: "u_doccr", updatedBy: "u_doccr" } });
  await db.kbDoc.create({ data: { id: CV, kbId: K, kind: "canvas", title: CV, createdBy: "u_doccr", updatedBy: "u_doccr" } });
  await db.kbDoc.create({ data: { id: DR, kbId: K, kind: "doc", title: DR, createdBy: "u_tabcr", updatedBy: "u_tabcr" } });
  await db.kbDoc.create({ data: { id: L1, kbId: K, kind: "doc", title: L1, createdBy: "u_tabcr", updatedBy: "u_tabcr" } });
  await db.kbDoc.create({ data: { id: L1C, kbId: K, kind: "doc", title: L1C, createdBy: "u_tabcr", updatedBy: "u_tabcr" } });

  const nav: NodeSpec[] = [
    { id: B, kind: "base", resourceType: "base", resourceId: B, parentId: null },
    { id: T, kind: "table", resourceType: "table", resourceId: T, parentId: B },
    { id: FT, kind: "table", resourceType: "table", resourceId: FT, parentId: B },
    { id: DR, kind: "doc", resourceType: "doc", resourceId: DR, parentId: null },
    { id: L1, kind: "doc", resourceType: "doc", resourceId: L1, parentId: B, inheritAncestors: 0 },
    { id: L1C, kind: "doc", resourceType: "doc", resourceId: L1C, parentId: L1 },
    { id: K, kind: "kb", resourceType: "kb", resourceId: K, parentId: null },
    { id: D, kind: "doc", resourceType: "doc", resourceId: D, parentId: K },
    { id: CV, kind: "canvas", resourceType: "canvas", resourceId: CV, parentId: K },
  ];
  await createNavNodes(db, nav);

  await createPolicies(db, [
    { id: "sp_p_b_user", nodeId: B, subjectType: "user", subjectId: "u_view", actions: "r" },
    { id: "sp_p_b_role", nodeId: B, subjectType: "role", subjectId: "sp_role_ru", actions: "r,u" },
    { id: "sp_p_dr_dept", nodeId: DR, subjectType: "dept", subjectId: "sp_D1", actions: "r" },
    { id: "sp_p_l1_user", nodeId: L1, subjectType: "user", subjectId: "u_l1", actions: "r" },
    { id: "sp_p_k_user", nodeId: K, subjectType: "user", subjectId: "u_kview", actions: "r" },
    { id: "sp_p_ft_mask", nodeId: FT, subjectType: "user", subjectId: "u_mask", actions: "r", fieldMask: '{"allowFields":["f1"]}' },
  ]);
}

beforeAll(async () => {
  h = await setupEngineHarness("gx-m4-scope-");
  db = h.prisma;
  await seed();
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

/** 计数 Proxy：与 query-count.test 同口径，但 $queryRawUnsafe 也计（scope 的 creator UNION 走它）。 */
function counted(client: PrismaClient) {
  const labels: string[] = [];
  const wrap = (delegate: object, name: string): unknown =>
    new Proxy(delegate, {
      get(t, prop, receiver) {
        if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
        const v = Reflect.get(t, prop, receiver);
        return typeof v === "function"
          ? (...a: unknown[]) => { labels.push(`${name}.${String(prop)}`); return Reflect.apply(v as (...x: unknown[]) => unknown, t, a); }
          : v;
      },
    });
  const wrapped = new Proxy(client, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
      const name = String(prop);
      const v = Reflect.get(t, prop, receiver);
      if (typeof v !== "function") return typeof v === "object" && v !== null && !name.startsWith("$") && !name.startsWith("_")
        ? wrap(v as object, name) : v;
      if (name === "$queryRawUnsafe") {
        return (...a: unknown[]) => { labels.push(name); return Reflect.apply(v as (...x: unknown[]) => unknown, t, a); };
      }
      return (v as (...x: unknown[]) => unknown).bind(t);
    },
  }) as unknown as PrismaClient;
  return { client: wrapped, labels: () => [...labels] };
}

const ALL_USERS = ["u_own", "u_cr", "u_kbcr", "u_doccr", "u_tabcr", "u_view", "u_role", "u_dept", "u_l1", "u_kview", "u_mask", "u_out"];
const ACTIONS = ["r", "u"] as const;

let allNodes: AuthzNode[];

async function decideAllows(userId: string, action: "r" | "u"): Promise<Map<string, boolean>> {
  const subject = await resolveSubject(userId, db as unknown as AuthzClient);
  const resolver = makeCreatedByResolver(db as unknown as AuthzClient);
  const out = new Map<string, boolean>();
  for (const n of allNodes) {
    const r = await decide(
      { client: db as unknown as AuthzClient, resolveCreatedBy: resolver },
      subject, n.id, action,
    );
    out.set(n.id, r.decision.allowed);
  }
  return out;
}

describe("scope <-> decide 零分叉（逐节点成员资格 0 差异）", () => {
  beforeAll(async () => {
    allNodes = await db.navNode.findMany({
      where: { workspaceId: "ws_default", deletedAt: null, resourceType: { not: null } },
    }) as unknown as AuthzNode[];
    expect(allNodes.length).toBe(9);
  });

  for (const action of ACTIONS) {
    it(`动作 ${action}：12 个主体 x 9 节点，scope 成员资格与逐节点 decide 完全一致`, async () => {
      const mismatches: string[] = [];
      for (const userId of ALL_USERS) {
        const scope = await resolveVisibleNodeIds(db as unknown as AuthzClient, userId, { actions: [action] });
        const scopeSet = new Set(scope.nodeIds);
        const decideMap = await decideAllows(userId, action);
        for (const n of allNodes) {
          const byDecide = decideMap.get(n.id)!;
          const byScope = scopeSet.has(n.id);
          if (byDecide !== byScope) {
            mismatches.push(`${userId}/${action}/${n.id}: decide=${byDecide} scope=${byScope}`);
          }
        }
        // visibleTotal 是截断前的可见全集大小，必须与 decide 真值计数相同。
        expect(scope.visibleTotal).toBe([...decideMap.values()].filter(Boolean).length);
      }
      expect(mismatches).toEqual([]);
    }, 180000);
  }

  it("prepareScope/nodeVisibleInPrepared 与一次性 resolve 同口径（公开原语一致性）", async () => {
    const prepared = await prepareScope(db as unknown as AuthzClient, "u_view");
    const byId = new Map(allNodes.map((n) => [n.id, n]));
    const scope = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_view", { actions: ["r"] });
    for (const n of allNodes) {
      const single = nodeVisibleInPrepared(prepared, byId.get(n.id)!, "r");
      expect(single).toBe(scope.nodeIds.includes(n.id));
    }
  });

  it("典型语义点抽查：creator 不沿树继承 / cutoff 裁剪 / owner 全可见 / 无关系全拒", async () => {
    const cr = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_cr", { actions: ["r"] });
    expect(cr.nodeIds).toEqual([B]); // 仅自己创建的 base；T 是 u_tabcr 创建，creator 不继承

    const view = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_view", { actions: ["r"] });
    expect(view.nodeIds.sort()).toEqual([B, T, FT].sort()); // B 直授；T/FT 沿继承；L1 cutoff 裁剪
    const viewU = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_view", { actions: ["u"] });
    expect(viewU.nodeIds).toEqual([]); // 只授 r

    const role = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_role", { actions: ["u"] });
    expect(role.nodeIds.sort()).toEqual([B, T, FT].sort()); // r,u 沿 B 继承到两表

    const dept = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_dept", { actions: ["r"] });
    expect(dept.nodeIds).toEqual([DR]); // 部门授予单点，不蔓延到兄弟

    const l1 = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_l1", { actions: ["r"] });
    expect(l1.nodeIds.sort()).toEqual([L1, L1C].sort()); // L1 直授 + cutoff 边界策略被孙 L1C 继承；B 不上溯

    const kv = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_kview", { actions: ["r"] });
    expect(kv.nodeIds.sort()).toEqual([K, D, CV].sort()); // kb 容器授 r，doc/canvas 子节点继承

    const own = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_own", { actions: ["r"] });
    expect(own.visibleTotal).toBe(9); // workspace owner 兜底全可见
    const out = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_out", { actions: ["r"] });
    expect(out.nodeIds).toEqual([]);
  });

  it("fieldMask：u_mask 节点级可见 FT，maskedTableFields 带白名单；resourceIdsByType 归集正确", async () => {
    const m = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_mask", { actions: ["r"] });
    expect(m.nodeIds).toEqual([FT]);
    expect(m.maskedTableFields[FT]).toEqual(["f1"]);
    expect(m.resourceIdsByType).toEqual({ table: [FT] });
    // 非 r 动作不产出字段掩码。
    const mu = await resolveVisibleNodeIds(db as unknown as AuthzClient, "u_mask", { actions: ["u"] });
    expect(mu.maskedTableFields).toEqual({});
    expect(mu.nodeIds).toEqual([]);
  });

  it("kinds 过滤 + budget 截断：owner budget=1 截断且 sql 契约转 temp_table", async () => {
    const tablesOnly = await resolveVisibleNodeIds(
      db as unknown as AuthzClient, "u_role", { actions: ["r"], kinds: ["table"] },
    );
    // path 序：/sp_base/sp_ftable/ 先于 /sp_base/sp_table/（f<t）。
    expect(tablesOnly.nodeIds).toEqual([FT, T]);
    expect(tablesOnly.resourceIdsByType).toEqual({ table: [FT, T] });
    expect(tablesOnly.truncated).toBe(false);
    expect(tablesOnly.sql.expectsTempTable).toBe(false);

    const tiny = await resolveVisibleNodeIds(
      db as unknown as AuthzClient, "u_own", { actions: ["r"], budget: 1 },
    );
    expect(tiny.nodeIds).toHaveLength(1);
    expect(tiny.visibleTotal).toBe(9);
    expect(tiny.truncated).toBe(true);
    expect(tiny.sql.expectsTempTable).toBe(true);
    expect(tiny.sql.sql).toBe("");
  });
});

describe("scope 客体批量 SQL 定数（主体 resolveSubject 之外）", () => {
  it("非 owner 恰 4 条：policy + nav + creator UNION + workspace", async () => {
    const c = counted(db);
    const scope = await resolveVisibleNodeIds(c.client as unknown as AuthzClient, "u_view", { actions: ["r"] });
    const labels = c.labels();
    const objectLabels = labels.slice(labels.indexOf("authPolicy.findMany"));
    expect(objectLabels).toEqual([
      "authPolicy.findMany",
      "navNode.findMany",
      "$queryRawUnsafe",
      "workspace.findUnique",
    ]);
    expect(scope.policyVersion).toBe(0);
  });

  it("owner 跳过 creator UNION：客体 3 条", async () => {
    const c = counted(db);
    await resolveVisibleNodeIds(c.client as unknown as AuthzClient, "u_own", { actions: ["r"] });
    const labels = c.labels();
    const objectLabels = labels.slice(labels.indexOf("authPolicy.findMany"));
    expect(objectLabels).toEqual(["authPolicy.findMany", "navNode.findMany", "workspace.findUnique"]);
    expect(labels).not.toContain("$queryRawUnsafe");
  });

  it("主体解析往返 ≤4 定数（各主体结构不同，上限同；深部门/多兼岗不增长在 S1 query-count 已证）", async () => {
    for (const userId of ["u_out", "u_dept", "u_own", "u_role"]) {
      const c = counted(db);
      const s: ResolvedSubject = await resolveSubject(userId, c.client as unknown as AuthzClient);
      expect(c.labels().length).toBeLessThanOrEqual(4);
      if (userId === "u_own") expect(s.isWorkspaceOwner).toBe(true);
    }
  });
});
