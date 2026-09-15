// M4/S10 规模门补充证据（计划 §7-S10 规模门行）：在 S4 scope-scale 夹具（500 用户 /
// 6 层部门 / 万节点 / 约 3000 策略，seedScale 复用不重造）上补四件 S4 未覆盖的事：
//
//   1) decide 点查在万节点规模下客体 SQL 仍为定数（冷 3：节点点查 + path IN 链 + 三源策略；
//      同版本链缓存命中 1：仅策略行），与节点总量/部门深度无关；
//   2) decide 点查 P95 实测（每请求独立链缓存 = 真实请求形态，252 个冷决策样本），
//      scope P95 沿用 scope-scale.test.ts 的 n=21 口径，数值同写 gate 文档；
//   3) policyVersion 读不 bump：resolveSubject + 多轮 decide + scope 批量前后
//      workspaces.policyVersion 逐字节不变（写侧 +1 由 policies-api/s7-inheritance 既有覆盖）；
//   4) decide 物理 SQL 的 EXPLAIN QUERY PLAN 全走索引（auth_policies_node_idx / 主键），
//      与 scope 四条物理 SQL 证据合为"七守对拍 + v1 两条读路"全索引覆盖。
//
// 开关：默认全量跳过（万节点造数重，防普通全量爆内存/拖慢）；门证据必须显式
//   GX_M4_GATE=1 pnpm --filter @gx/api exec vitest run \
//     src/domain/authz/__tests__/scope-scale.test.ts \
//     src/domain/authz/__tests__/s10-scale-gate.test.ts --fileParallelism=false
// 真跑到数，数值写 docs/baseline/2026-09-16-m4-gate.md。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { setupEngineHarness, type EngineHarness } from "./engineHarness.js";
import { resolveSubject } from "../subjects.js";
import { decide, type EngineDeps } from "../engine.js";
import { makeCreatedByResolver } from "../adapter.js";
import { resolveVisibleNodeIds } from "../scope.js";
import { navVersionOf, NavChainCache } from "../nodes.js";
import type { AuthzClient } from "../types.js";
import { N_NAV, counted, percentile, seedScale } from "./scopeScaleHarness.js";

const GATE_ON = process.env.GX_M4_GATE === "1";
const gateDescribe = GATE_ON ? describe : describe.skip;

const SCOPE_BUDGET = 20_000;
const N_SAMPLE_USERS = 12;
const N_SAMPLE_NODES = 21;

let h!: EngineHarness;
let db!: PrismaClient;
let rawDbPath = "";

beforeAll(async () => {
  // 非门模式：gateDescribe 全 skip，用例体不执行，不建库不造数。
  if (!GATE_ON) return;
  h = await setupEngineHarness("gx-m4-s10-gate-");
  db = h.prisma;
  await seedScale(db);
}, 600_000);

afterAll(async () => {
  if (h) await h.cleanup();
});

const SAMPLE_USERS = [
  "su_0000", "su_0001", "su_0049", "su_0050", "su_0099", "su_0123",
  "su_0200", "su_0300", "su_0400", "su_0450", "su_0498", "su_0499",
];

async function sampleNodeIds(): Promise<string[]> {
  const all = await db.navNode.findMany({
    where: { deletedAt: null, resourceType: { not: null } },
    select: { id: true }, orderBy: { path: "asc" },
  });
  expect(all.length).toBe(N_NAV);
  return Array.from({ length: N_SAMPLE_NODES }, (_, i) =>
    all[Math.floor((i * all.length) / N_SAMPLE_NODES)]!.id);
}

gateDescribe("S10 规模门：decide 点查 SQL 定数（万节点下仍冷 3 / 缓存 1）", () => {
  // 客体三往返切到 authPolicy.findMany 为止；其后 createdBy resolver 可能追加至多 1 次
  // 实体点查（base/table/kbDoc/knowledgeBase，adapter 进程内缓存命中则 0），单独断言。
  function objectLeg(labels: string[]): string[] {
    const start = labels.indexOf("navNode.findFirst");
    const end = labels.indexOf("authPolicy.findMany");
    return labels.slice(start, end + 1);
  }
  function creatorLeg(labels: string[]): string[] {
    return labels.filter((l) =>
      ["base.findUnique", "table.findUnique", "kbDoc.findUnique", "knowledgeBase.findUnique"].includes(l));
  }

  it("普通用户冷决策客体恰 3 条往返 + creator 兜底至多 1；同节点二次决策仅策略行 1 条", async () => {
    const nodes = await sampleNodeIds();
    const subject = await resolveSubject("su_0123", db as unknown as AuthzClient);
    const version = await navVersionOf(db as unknown as AuthzClient, "ws_default");

    const cache = new NavChainCache();
    const c1 = counted(db);
    const deps1: EngineDeps = {
      client: c1.client as unknown as AuthzClient, navVersion: version, cache,
      resolveCreatedBy: makeCreatedByResolver(c1.client as unknown as AuthzClient),
    };
    const r1 = await decide(deps1, subject, nodes[7]!, "r");
    expect(typeof r1.decision.allowed).toBe("boolean");
    expect(objectLeg(c1.labels())).toEqual([
      "navNode.findFirst", "navNode.findMany", "authPolicy.findMany",
    ]);
    expect(creatorLeg(c1.labels()).length).toBeLessThanOrEqual(1);

    const c2 = counted(db);
    const deps2: EngineDeps = {
      client: c2.client as unknown as AuthzClient, navVersion: version, cache,
      resolveCreatedBy: makeCreatedByResolver(c2.client as unknown as AuthzClient),
    };
    await decide(deps2, subject, nodes[7]!, "r");
    expect(c2.labels().filter((l) => l === "authPolicy.findMany").length).toBe(1);
    expect(c2.labels()).not.toContain("navNode.findFirst");
    expect(c2.labels()).not.toContain("navNode.findMany");
  });

  it("每请求独立缓存（真实对拍形态）连续 21 个不同叶子客体恒各 3 条，不随已决策节点数增长", async () => {
    const nodes = await sampleNodeIds();
    const subject = await resolveSubject("su_0007", db as unknown as AuthzClient);
    const version = await navVersionOf(db as unknown as AuthzClient, "ws_default");

    for (const id of nodes) {
      const c = counted(db);
      const deps: EngineDeps = {
        client: c.client as unknown as AuthzClient, navVersion: version, cache: new NavChainCache(),
        resolveCreatedBy: makeCreatedByResolver(c.client as unknown as AuthzClient),
      };
      await decide(deps, subject, id, "r");
      expect(objectLeg(c.labels())).toEqual(["navNode.findFirst", "navNode.findMany", "authPolicy.findMany"]);
      expect(creatorLeg(c.labels()).length).toBeLessThanOrEqual(1);
    }
  }, 120_000);
});

gateDescribe("S10 规模门：decide 点查 P95 实测（12 用户 x 21 抽样节点 = 252 冷决策）", () => {
  it("每请求独立链缓存 + 真 createdBy 点查，P50/P95/MAX 打印留证并在宽松上界内", async () => {
    const nodes = await sampleNodeIds();
    const subjects = await Promise.all(
      SAMPLE_USERS.map((u) => resolveSubject(u, db as unknown as AuthzClient)),
    );
    const version = await navVersionOf(db as unknown as AuthzClient, "ws_default");

    // 预热一轮（迁移临时库首读含连接/计划冷启动），不计入样本。
    for (let i = 0; i < N_SAMPLE_USERS; i++) {
      await decide({
        client: db as unknown as AuthzClient, navVersion: version, cache: new NavChainCache(),
        resolveCreatedBy: makeCreatedByResolver(db as unknown as AuthzClient),
      }, subjects[i]!, nodes[0]!, "r");
    }

    const timings: number[] = [];
    for (let i = 0; i < N_SAMPLE_USERS; i++) {
      for (const id of nodes) {
        const deps: EngineDeps = {
          client: db as unknown as AuthzClient, navVersion: version, cache: new NavChainCache(),
          resolveCreatedBy: makeCreatedByResolver(db as unknown as AuthzClient),
        };
        const t0 = performance.now();
        await decide(deps, subjects[i]!, id, "r");
        timings.push(performance.now() - t0);
      }
    }
    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);
    const max = timings[timings.length - 1]!;
    console.log(
      `[m4-s10-gate] decide cold n=${timings.length} P50=${p50.toFixed(2)}ms `
      + `P95=${p95.toFixed(2)}ms MAX=${max.toFixed(2)}ms`,
    );
    expect(timings.length).toBe(N_SAMPLE_USERS * N_SAMPLE_NODES);
    // 团队线 p95<500ms；本机测试机留 2x 余量防假阴，绝对值以 gate 文档为准。
    expect(p95).toBeLessThan(1000);
  }, 180_000);
});

gateDescribe("S10 规模门：policyVersion 仅写事务 bump，读链路零 bump", () => {
  it("resolveSubject + 多轮 decide + scope 批量前后 workspaces.policyVersion 不变", async () => {
    const nodes = await sampleNodeIds();
    const readVersion = async () =>
      (await db.workspace.findUniqueOrThrow({ where: { id: "ws_default" }, select: { policyVersion: true } }))
        .policyVersion;

    const v0 = await readVersion();
    for (const u of ["su_0001", "su_0123", "su_0499"]) {
      const subject = await resolveSubject(u, db as unknown as AuthzClient);
      const version = await navVersionOf(db as unknown as AuthzClient, "ws_default");
      for (const id of nodes.slice(0, 8)) {
        await decide({
          client: db as unknown as AuthzClient, navVersion: version, cache: new NavChainCache(),
          resolveCreatedBy: makeCreatedByResolver(db as unknown as AuthzClient),
        }, subject, id, "r");
      }
    }
    await resolveVisibleNodeIds(db as unknown as AuthzClient, "su_0001", { actions: ["r"], budget: SCOPE_BUDGET });
    await resolveVisibleNodeIds(db as unknown as AuthzClient, "su_0499", { actions: ["r", "u"], budget: SCOPE_BUDGET });
    const v1 = await readVersion();
    expect(v1).toBe(v0);

    // 读侧零 UPDATE 旁证：workspace delegate 在整段只读流程中无 update 调用。
    const c = counted(db);
    await resolveVisibleNodeIds(c.client as unknown as AuthzClient, "su_0200", { actions: ["r"], budget: SCOPE_BUDGET });
    expect(c.labels()).not.toContain("workspace.update");
  }, 180_000);
});

gateDescribe("S10 规模门：decide 物理 SQL EXPLAIN QUERY PLAN 无全表 SCAN", () => {
  it("链节点点查/IN 走主键，三源策略走 auth_policies_node_idx，navVersion 走工作区主键", async () => {
    const s = await resolveSubject("su_0001", db as unknown as AuthzClient);
    const roleIn = s.roleIds.length ? s.roleIds : ["__none__"];
    const deptIn = s.deptAncestorIds.length ? s.deptAncestorIds : ["__none__"];
    const chainIds = ["sdoc_00000", "st_000_0", "sb_000"];
    const plans: { label: string; sql: string; params: unknown[] }[] = [
      {
        label: "navNodeFindFirst",
        sql: `SELECT * FROM nav_nodes WHERE id=? AND deletedAt IS NULL`,
        params: ["sdoc_00000"],
      },
      {
        label: "navNodeChainIn",
        sql: `SELECT * FROM nav_nodes WHERE id IN (${chainIds.map(() => "?").join(",")})`,
        params: chainIds,
      },
      {
        label: "policiesOnNodesTx",
        sql: `SELECT id,nodeId,subjectType,subjectId,actions,fieldMask FROM auth_policies
              WHERE nodeId IN (${chainIds.map(() => "?").join(",")}) AND (
                (subjectType='user' AND subjectId=?)
                OR (subjectType='role' AND subjectId IN (${roleIn.map(() => "?").join(",")}))
                OR (subjectType='dept' AND subjectId IN (${deptIn.map(() => "?").join(",")})))`,
        params: [...chainIds, "su_0001", ...roleIn, ...deptIn],
      },
      {
        label: "workspaceNavVersion",
        sql: `SELECT "navVersion" FROM "workspaces" WHERE id=?`,
        params: ["ws_default"],
      },
    ];

    if (!rawDbPath) {
      const url = process.env.DATABASE_URL!;
      rawDbPath = url.startsWith("file:") ? url.slice(5) : url;
    }
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(rawDbPath, { readonly: true, fileMustExist: true });
    try {
      for (const p of plans) {
        const rows = raw.prepare(`EXPLAIN QUERY PLAN ${p.sql}`).all(...(p.params as never[])) as { detail: string }[];
        const detail = rows.map((r) => r.detail).join("\n");
        console.log(`[m4-s10-gate] EXPLAIN ${p.label}:\n${detail}`);
        const forbidden = /SCAN (auth_policies|nav_nodes|workspaces)\b/;
        expect(detail, `${p.label} 出现全表 SCAN:\n${detail}`).not.toMatch(forbidden);
      }
    } finally {
      raw.close();
    }
  }, 120_000);
});
