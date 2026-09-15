// M4/S1 SQL 计数验收（M4 计划 §7-S1）：
//   夹具 6 层部门链 + 4 并列部门 = 10 部门，10 用户各兼全部 10 岗（10 兼岗），
//   客体 7 层 nav 链。口径与 M2 s8-query-count 一致：Prisma 模型委托往返
//   （SQLite connector 无 query 日志，ORM 往返即既定客观口径）。
//
// 断言：
//   - 主体 resolveSubject 往返为定数（M2 effectiveRoleRows ≤3 + 部门 1），
//     加部门层数/兼岗后不增长；
//   - 单节点决策【客体部分】≤3：navVersion 由调用方预取传入（批量复用）时
//     = 节点点查 1 + 祖先链 path 一次 IN 1 + 策略行三源 OR 1，与 nav 层数/节点总数无关；
//     祖先链经 navVersion LRU 缓存，二次决策同节点仅策略行 1；
//   - 不同深度（7 层 vs 3 层）冷决策计数相同（path 切段后一次 IN 取全链，不逐层点查）。

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
} from "./engineHarness.js";
import { resolveSubject } from "../subjects.js";
import { decide, type EngineDeps } from "../engine.js";
import { navVersionOf, NavChainCache } from "../nodes.js";
import type { AuthzClient, ResolvedSubject } from "../types.js";

let h: EngineHarness;
let db: PrismaClient;

/** 全委托计数 Proxy：任一模型的函数式方法被调计一次 ORM 往返；`$`/`_` 内部属性透传。 */
function countedAll(client: PrismaClient) {
  let calls = 0;
  const labels: string[] = [];
  const wrapDelegate = (delegate: object, name: string): unknown =>
    new Proxy(delegate, {
      get(t, prop, receiver) {
        if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
        const v = Reflect.get(t, prop, receiver);
        return typeof v === "function"
          ? (...a: unknown[]) => { calls++; labels.push(`${name}.${String(prop)}`); return Reflect.apply(v as (...x: unknown[]) => unknown, t, a); }
          : v;
      },
    });
  const wrapped = new Proxy(client, {
    get(t, prop, receiver) {
      if (typeof prop === "symbol" || String(prop).startsWith("$") || String(prop).startsWith("_")) {
        const v = Reflect.get(t, prop, receiver);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      }
      return wrapDelegate(Reflect.get(t, prop, receiver) as object, String(prop));
    },
  }) as unknown as PrismaClient;
  return {
    client: wrapped,
    count: () => calls,
    labels: () => [...labels],
    reset: () => { calls = 0; labels.length = 0; },
  };
}

beforeAll(async () => {
  h = await setupEngineHarness("gx-m4-count-");
  db = h.prisma;

  // 6 层部门链 C1..C6 + 4 并列 C7..C10（挂 C1）。
  const deptSpecs = [];
  for (let i = 1; i <= 6; i++) {
    const id = `dept_c${i}`;
    const parent = i === 1 ? null : `dept_c${i - 1}`;
    const segs = Array.from({ length: i }, (_, k) => `dept_c${k + 1}`);
    deptSpecs.push({ id, parentId: parent, path: `/${segs.join("/")}/` });
  }
  for (let i = 7; i <= 10; i++) {
    deptSpecs.push({ id: `dept_c${i}`, parentId: "dept_c1", path: `/dept_c1/dept_c${i}/` });
  }
  await createDepts(db, deptSpecs);
  const deptIds = deptSpecs.map((d) => d.id);

  await createUsers(db, Array.from({ length: 10 }, (_, k) => ({ id: `uc_${k}` })));
  const memberships = [];
  for (let k = 0; k < 10; k++) {
    for (let d = 0; d < deptIds.length; d++) {
      memberships.push({ id: `dm_${k}_${d}`, departmentId: deptIds[d]!, userId: `uc_${k}`, isMain: d === 2 ? 1 : 0 });
    }
  }
  await addDeptMembership(db, memberships);

  // 授给祖先部门 C1 的角色，使祖先闭包实际被命中。
  await createRole(db, { id: "role_cnt" });
  await assignRole(db, { roleId: "role_cnt", subjectType: "dept", subjectId: "dept_c1" });

  // 7 层 nav 链：root0 -> lvl1 -> ... -> lvl6（决策最深处叶子 lvl6）。
  const navSpecs = [];
  for (let i = 0; i <= 6; i++) {
    navSpecs.push({ id: `nav_l${i}`, kind: "doc", parentId: i === 0 ? null : `nav_l${i - 1}` });
  }
  await createNavNodes(db, navSpecs);
  // 3 层独立链 rootA -> a1 -> a2。
  await createNavNodes(db, [
    { id: "nav_a0", kind: "doc", parentId: null },
    { id: "nav_a1", kind: "doc", parentId: "nav_a0" },
    { id: "nav_a2", kind: "doc", parentId: "nav_a1" },
  ]);

  // 策略：role_cnt 经祖先链在 root 节点授 r（7 层叶子继承）；C1 部门在 a0 授 r。
  await createPolicies(db, [
    { id: "pol_root_role", nodeId: "nav_l0", subjectType: "role", subjectId: "role_cnt", actions: "r" },
    { id: "pol_a0_dept", nodeId: "nav_a0", subjectType: "dept", subjectId: "dept_c1", actions: "r" },
  ]);
}, 120000);

afterAll(async () => {
  await h.cleanup();
});

describe("resolveSubject 主体展开定数（与部门层数/兼岗数无关）", () => {
  it("6 层 + 10 兼岗为定数；再叠 6 层深部门计数不增长", async () => {
    const c1 = countedAll(db);
    const s1 = await resolveSubject("uc_0", c1.client as unknown as AuthzClient);
    const first = c1.count();
    expect(s1.roleIds).toContain("role_cnt");
    expect(s1.deptAncestorIds).toContain("dept_c1");
    // effectiveRoleRows ≤3 + 部门归属 1。
    expect(first).toBeLessThanOrEqual(4);

    // 追加更深 6 层部门与兼岗。
    const extra: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const id = `dept_x${i}`;
      const parent = i === 1 ? "dept_c6" : `dept_x${i - 1}`;
      const parentPath = (await db.department.findUniqueOrThrow({ where: { id: parent! } })).path;
      await db.department.create({ data: { id, workspaceId: "ws_default", parentId: parent, path: `${parentPath}${id}/`, name: id } });
      extra.push(id);
    }
    await addDeptMembership(db, extra.map((d, i) => ({ id: `dmx_${i}`, departmentId: d, userId: "uc_0", isMain: 0 })));

    const c2 = countedAll(db);
    await resolveSubject("uc_0", c2.client as unknown as AuthzClient);
    expect(c2.count()).toBe(first);
  });
});

describe("decide 客体部分 ≤3 且与 nav 层数/节点数无关", () => {
  let subject: ResolvedSubject;
  let version: number;

  beforeAll(async () => {
    subject = await resolveSubject("uc_0", db as unknown as AuthzClient);
    version = await navVersionOf(db as unknown as AuthzClient, "ws_default");
  });

  it("7 层链冷决策 = 3（节点点查 + 链 path IN + 策略行），逐层不增", async () => {
    const c = countedAll(db);
    const deps: EngineDeps = { client: c.client as unknown as AuthzClient, navVersion: version, cache: new NavChainCache() };
    const r = await decide(deps, subject, "nav_l6", "r");
    expect(r.decision.allowed).toBe(true);
    expect(c.count()).toBe(3);
    expect(c.labels()).toEqual(["navNode.findFirst", "navNode.findMany", "authPolicy.findMany"]);
  });

  it("3 层链冷决策同为 3（深度变化计数恒定）", async () => {
    const c = countedAll(db);
    const deps: EngineDeps = { client: c.client as unknown as AuthzClient, navVersion: version, cache: new NavChainCache() };
    const r = await decide(deps, subject, "nav_a2", "r");
    expect(r.decision.allowed).toBe(true);
    expect(c.count()).toBe(3);
  });

  it("同节点二次决策（链缓存命中）仅策略行 1；第三动作未授 -> 拒绝但计数仍 1", async () => {
    const cache = new NavChainCache();
    const c1 = countedAll(db);
    const deps1: EngineDeps = { client: c1.client as unknown as AuthzClient, navVersion: version, cache };
    await decide(deps1, subject, "nav_l6", "r");
    expect(c1.count()).toBe(3);

    const c2 = countedAll(db);
    const deps2: EngineDeps = { client: c2.client as unknown as AuthzClient, navVersion: version, cache };
    const denied = await decide(deps2, subject, "nav_l6", "manage_share");
    expect(denied.decision.allowed).toBe(false);
    expect(c2.count()).toBe(1);
    expect(c2.labels()).toEqual(["authPolicy.findMany"]);
  });

  it("同 cache 内决策两个不同叶子：冷节点各 3，不随已缓存节点数增长", async () => {
    const cache = new NavChainCache();
    const c = countedAll(db);
    const deps: EngineDeps = { client: c.client as unknown as AuthzClient, navVersion: version, cache };
    await decide(deps, subject, "nav_l6", "r");
    const afterFirst = c.count();
    await decide(deps, subject, "nav_l5", "r");
    expect(c.count() - afterFirst).toBe(3);
  });
});
