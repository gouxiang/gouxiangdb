// M4/S4 规模门（计划 §7-S4）：500 用户 / 6 层部门 / 人均 2 部门 / 1 万 nav 节点 / 约 3000 策略。
//
// 独立文件、强制串行（复验命令带 --fileParallelism=false）。造数在 scopeScaleHarness.ts，本文件只断言：
//   1) SQL 定数：非 owner 客体恰 4 条（policy/nav/creator UNION/workspace），owner 3 条；
//   2) 零分叉：12 抽样用户 x 500 抽样节点，scope 成员资格与逐节点 decide 在 r/u 两动作上 0 差异；
//   3) EXPLAIN QUERY PLAN：四条物理 SQL 无对持久表的裸 SCAN（createdBy 四索引迁移后覆盖）；
//   4) P95：21 次 scope 服务端计时，打印 P50/P95 留证并断言宽松上界（绝对值写 baseline 文档）。
//
// 不跑 1 万 x 500 全组合（500 万次 decide 无意义）；等距抽样覆盖 base/table/doc 三档深度与各源分支。
//
// 开关（S10 起）：万节点造数重，普通全量默认跳过；门证据显式真跑：
//   GX_M4_GATE=1 pnpm --filter @gx/api exec vitest run \
//     src/domain/authz/__tests__/scope-scale.test.ts \
//     src/domain/authz/__tests__/s10-scale-gate.test.ts --fileParallelism=false

import { afterAll, beforeAll, describe as vitestDescribe, expect, it } from "vitest";

const describe = process.env.GX_M4_GATE === "1" ? vitestDescribe : vitestDescribe.skip;
import type { PrismaClient } from "@prisma/client";
import { setupEngineHarness, type EngineHarness } from "./engineHarness.js";
import { resolveSubject } from "../subjects.js";
import { decide } from "../engine.js";
import { makeCreatedByResolver } from "../adapter.js";
import { resolveVisibleNodeIds } from "../scope.js";
import type { AuthzClient } from "../types.js";
import {
  N_NAV, counted, percentile, seedScale,
} from "./scopeScaleHarness.js";

const SCOPE_BUDGET = 20_000; // 门内不截断（10000 < 20000 硬上限）
const N_PARITY_USERS = 12;
const N_PARITY_NODES = 500;

let h!: EngineHarness;
let db!: PrismaClient;
let rawDbPath = "";

beforeAll(async () => {
  // 非门模式：describe 全 skip，用例体不执行，不建库不造数。
  if (process.env.GX_M4_GATE !== "1") return;
  h = await setupEngineHarness("gx-m4-scale-");
  db = h.prisma;
  await seedScale(db);
}, 600_000);

afterAll(async () => {
  if (h) await h.cleanup();
});

describe("规模夹具结构（500 用户 / 6 层部门 / 万节点 / 3000 策略）", () => {
  it("行数符合计划口径", async () => {
    expect(await db.user.count()).toBe(500);
    expect(await db.department.count()).toBe(31); // 1 根 + 5 层 x 6
    expect(await db.navNode.count({ where: { deletedAt: null } })).toBe(N_NAV);
    expect(await db.base.count()).toBe(40);
    expect(await db.table.count()).toBe(400);
    expect(await db.authPolicy.count()).toBeGreaterThanOrEqual(2950);
    expect(await db.deptMember.count()).toBeGreaterThanOrEqual(900);
  });
});

describe("规模下 scope SQL 定数（与节点数无关，恒 <=4）", () => {
  it("普通用户客体恰 4 条；owner 3 条（跳过 creator UNION）", async () => {
    const c1 = counted(db);
    await resolveVisibleNodeIds(c1.client as unknown as AuthzClient, "su_0001", { actions: ["r"], budget: SCOPE_BUDGET });
    const labels1 = c1.labels();
    expect(labels1.slice(labels1.indexOf("authPolicy.findMany"))).toEqual([
      "authPolicy.findMany", "navNode.findMany", "$queryRawUnsafe", "workspace.findUnique",
    ]);

    const c2 = counted(db);
    await resolveVisibleNodeIds(c2.client as unknown as AuthzClient, "su_0499", { actions: ["r"], budget: SCOPE_BUDGET });
    const labels2 = c2.labels();
    expect(labels2.slice(labels2.indexOf("authPolicy.findMany"))).toEqual([
      "authPolicy.findMany", "navNode.findMany", "workspace.findUnique",
    ]);
    expect(labels2).not.toContain("$queryRawUnsafe");
  });
});

describe("规模下 scope <-> decide 零分叉（12 用户 x 500 抽样节点）", () => {
  it("r/u 两动作逐节点布尔一致，0 差异", async () => {
    const sampleUsers = [
      "su_0000", "su_0001", "su_0049", "su_0050", "su_0099", "su_0123",
      "su_0200", "su_0300", "su_0400", "su_0450", "su_0498", "su_0499",
    ];
    expect(sampleUsers).toHaveLength(N_PARITY_USERS);
    const allNodes = await db.navNode.findMany({
      where: { deletedAt: null, resourceType: { not: null } },
      select: { id: true }, orderBy: { path: "asc" },
    });
    expect(allNodes.length).toBe(N_NAV);
    const sampleNodes = Array.from({ length: N_PARITY_NODES }, (_, i) =>
      allNodes[Math.floor((i * allNodes.length) / N_PARITY_NODES)]!.id);

    const mismatches: string[] = [];
    for (const userId of sampleUsers) {
      for (const action of ["r", "u"] as const) {
        const subject = await resolveSubject(userId, db as unknown as AuthzClient);
        const resolver = makeCreatedByResolver(db as unknown as AuthzClient);
        const scope = await resolveVisibleNodeIds(
          db as unknown as AuthzClient, userId, { actions: [action], budget: SCOPE_BUDGET },
        );
        const scopeSet = new Set(scope.nodeIds);
        for (const nodeId of sampleNodes) {
          const d = await decide(
            { client: db as unknown as AuthzClient, resolveCreatedBy: resolver },
            subject, nodeId, action,
          );
          if (d.decision.allowed !== scopeSet.has(nodeId)) {
            mismatches.push(`${userId}/${action}/${nodeId}: decide=${d.decision.allowed} scope=${scopeSet.has(nodeId)}`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  }, 300_000);
});

describe("规模下 EXPLAIN QUERY PLAN：四条物理 SQL 无全表 SCAN", () => {
  it("policy 三源 OR / nav 活节点 / creator UNION / workspace 点查均走索引", async () => {
    const s = await resolveSubject("su_0001", db as unknown as AuthzClient);
    const roleIn = s.roleIds.length ? s.roleIds : ["__none__"];
    const deptIn = s.deptAncestorIds.length ? s.deptAncestorIds : ["__none__"];
    const plans: { label: string; sql: string; params: unknown[] }[] = [
      {
        label: "policiesForSubjectTx",
        sql: `SELECT id,nodeId,subjectType,subjectId,actions,fieldMask FROM auth_policies
              WHERE workspaceId=? AND (
                (subjectType='user' AND subjectId=?)
                OR (subjectType='role' AND subjectId IN (${roleIn.map(() => "?").join(",")}))
                OR (subjectType='dept' AND subjectId IN (${deptIn.map(() => "?").join(",")})))`,
        params: ["ws_default", "su_0001", ...roleIn, ...deptIn],
      },
      {
        label: "navNodesLive",
        sql: `SELECT * FROM nav_nodes WHERE workspaceId=? AND deletedAt IS NULL`,
        params: ["ws_default"],
      },
      {
        label: "creatorUnion",
        sql: `SELECT 'base' AS t, "id" AS rid FROM "bases" WHERE "createdBy" = ? AND "deletedAt" IS NULL
              UNION ALL
              SELECT 'kb' AS t, "id" AS rid FROM "knowledge_bases" WHERE "createdBy" = ? AND "deletedAt" IS NULL
              UNION ALL
              SELECT 'kind' AS t, "id" AS rid FROM "kb_docs" WHERE "createdBy" = ? AND "deletedAt" IS NULL
              UNION ALL
              SELECT 'table' AS t, "id" AS rid FROM "tables" WHERE "createdBy" = ? AND "deletedAt" IS NULL`,
        params: ["su_0001", "su_0001", "su_0001", "su_0001"],
      },
      {
        label: "workspaceVersion",
        sql: `SELECT "policyVersion" FROM "workspaces" WHERE id=?`,
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
        const forbidden = /SCAN (auth_policies|nav_nodes|bases|knowledge_bases|kb_docs|tables|workspaces)\b/;
        expect(detail, `${p.label} 出现全表 SCAN:\n${detail}`).not.toMatch(forbidden);
      }
    } finally {
      raw.close();
    }
  }, 120_000);
});

describe("规模下 scope P95 时延留证", () => {
  it("21 次调用计时打印 P50/P95 并在上界内", async () => {
    const timings: number[] = [];
    const users = Array.from({ length: 20 }, (_, i) => `su_${(i * 23 + 3).toString().padStart(5, "0")}`);
    for (const u of users) {
      const t0 = performance.now();
      await resolveVisibleNodeIds(db as unknown as AuthzClient, u, { actions: ["r"], budget: SCOPE_BUDGET });
      timings.push(performance.now() - t0);
    }
    const t0 = performance.now();
    await resolveVisibleNodeIds(db as unknown as AuthzClient, "su_0499", { actions: ["r"], budget: SCOPE_BUDGET });
    timings.push(performance.now() - t0);

    timings.sort((a, b) => a - b);
    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);
    const max = timings[timings.length - 1]!;
    console.log(`[m4-s4-scale] scope n=${timings.length} P50=${p50.toFixed(1)}ms P95=${p95.toFixed(1)}ms MAX=${max.toFixed(1)}ms`);
    // 回归上界：团队性能标准 p95<500ms；本机测试机波动留 2x 余量防假阴，绝对值以 baseline 文档为准。
    expect(p95).toBeLessThan(1000);
  }, 180_000);
});
