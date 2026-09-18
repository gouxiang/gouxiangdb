// M2/S8 管理面 500 成员规模留证（计划 §7-S8 第 3 条）。
//
// beforeAll 造 500 ACTIVE 用户 + 6 层部门 + 确定性伪随机兼岗（可复现，见 mulberry32）；
// 经真 createApp HTTP 打 GET /api/v1/org/members?limit=100，记录服务端处理耗时。
// 目标：P95 < 150ms（管理面非 SPEC 硬指标，超阈只留证不 fail——但实测中位数/最大值打印，
// 并断言一个宽松防回归上界 1000ms，防止静默劣化到秒级）。
// 三接口首屏对照：members / departments / roles 并行总时长也一并打印（M2 仅基线，硬指标在 M3）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupOrgHarness, type OrgHarness } from "./orgHarness.js";

// 确定性 PRNG：固定种子 -> 每次造数分布一致（可复现）。
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 500;
const SAMPLES = 21; // 奇数便于取中位；首轮含冷启动

let h: OrgHarness;
let ownerToken: string;

beforeAll(async () => {
  h = await setupOrgHarness();
  const rnd = mulberry32(20260915);

  // 6 层部门链（直插，避开 HTTP 逐跳开销；夹具已在组织域内）
  const deptIds: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const id = `perf_d${i}`;
    const parent = i === 1 ? null : deptIds[i - 2];
    const parentPath = parent ? (await h.prisma.department.findUniqueOrThrow({ where: { id: parent } })).path : "";
    await h.prisma.department.create({
      data: { id, workspaceId: "ws_default", parentId: parent, path: parentPath ? `${parentPath}${id}/` : `/${id}/`, name: `P${i}` },
    });
    deptIds.push(id);
  }

  // 500 ACTIVE 用户
  await h.prisma.user.createMany({
    data: Array.from({ length: N }, (_, k) => ({
      id: `perf_u${k}`, email: `perf${k}@x.com`, displayName: `成员${k}`,
      passwordHash: "x", workspaceId: "ws_default", status: "ACTIVE",
    })),
  });
  // 确定性随机兼岗：每用户 1~3 个部门，首个为主
  const memberRows = [] as Array<{ id: string; departmentId: string; userId: string; isMain: number }>;
  for (let k = 0; k < N; k++) {
    const pick = new Set<number>();
    const cnt = 1 + Math.floor(rnd() * 3);
    while (pick.size < cnt) pick.add(Math.floor(rnd() * 6));
    let mainSet = false;
    for (const d of pick) {
      memberRows.push({
        id: `perf_dm_${k}_${d}`, departmentId: deptIds[d], userId: `perf_u${k}`,
        isMain: mainSet ? 0 : 1,
      });
      mainSet = true;
    }
  }
  await h.prisma.deptMember.createMany({ data: memberRows });

  await h.createUser("perf_owner");
  await h.grantSystemRole("perf_owner");
  ownerToken = await h.token("perf_owner");
}, 120000);

afterAll(() => h.cleanup());

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

describe(`管理面成员列表 ${N} 成员规模（留证，非硬指标）`, () => {
  it("GET /members?limit=100 五页结果正确且耗时有界", async () => {
    const durations: number[] = [];
    let totalSeen = 0;
    for (let page = 1; page <= 5; page++) {
      const t0 = performance.now();
      const res = await h.app.request(`/api/v1/org/members?page=${page}&limit=100`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      durations.push(performance.now() - t0);
      expect(res.status).toBe(200);
      const body = await res.json() as { items: unknown[]; total: number; hasMore: boolean };
      expect(body.items).toHaveLength(100);
      expect(body.total).toBe(N + 1); // 含 owner
      totalSeen += body.items.length;
    }
    expect(totalSeen).toBe(500);

    const sorted = [...durations].sort((a, b) => a - b);
    const median = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const max = sorted[sorted.length - 1];
    // 留证（vitest 输出可见）：目标 P95<150ms，仅打印不据此 fail。
    console.log(`[S8 perf] members?limit=100 over ${N} users (5 pages, ms): median=${median.toFixed(2)} p95=${p95.toFixed(2)} max=${max.toFixed(2)}`);
    expect(median).toBeLessThan(150); // 中位目标作为常规门（500 行分页轻松满足）
    expect(max).toBeLessThan(1000);   // 宽松防回归上界
  });

  it(`重复采样 ${SAMPLES} 次首页并打印 P95（含首轮冷启动，仅留证）`, async () => {
    const durations: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = performance.now();
      const res = await h.app.request("/api/v1/org/members?page=1&limit=100", {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      durations.push(performance.now() - t0);
      expect(res.status).toBe(200);
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const warm = sorted.slice(1); // 去掉首轮冷启动
    const p95Warm = percentile(warm, 95);
    console.log(`[S8 perf] first-page x${SAMPLES}: cold=${sorted[0].toFixed(2)} warmMedian=${percentile(warm, 50).toFixed(2)} warmP95=${p95Warm.toFixed(2)} max=${sorted[sorted.length - 1].toFixed(2)} ms`);
    expect(p95Warm).toBeLessThan(1000);
  });

  it("通讯录首屏三接口（members/departments/roles）并行总时长留证", async () => {
    const t0 = performance.now();
    const [m, d, r] = await Promise.all([
      h.app.request("/api/v1/org/members?page=1&limit=100", { headers: { Authorization: `Bearer ${ownerToken}` } }),
      h.app.request("/api/v1/org/departments", { headers: { Authorization: `Bearer ${ownerToken}` } }),
      h.app.request("/api/v1/org/roles", { headers: { Authorization: `Bearer ${ownerToken}` } }),
    ]);
    const elapsed = performance.now() - t0;
    expect([m.status, d.status, r.status]).toEqual([200, 200, 200]);
    console.log(`[S8 perf] contacts first-screen parallel 3 endpoints: ${elapsed.toFixed(2)} ms (target <1000 ms; M3 nav SPEC 硬指标)`);
    expect(elapsed).toBeLessThan(1000);
  });
});

// 门控硬阈值（SPEC 宽松门 p95<150ms）：默认 skip，常规 CI/全量门零抖动、零额外耗时；
// 仅 GX_PERF_GATE=1 时执行。复用 beforeAll 已造好的同一批 500 成员夹具与 percentile 口径
// （不新起造数），逐接口独立采样、去首轮冷启动后取 warm p95。
const perfGateIt = process.env.GX_PERF_GATE ? it : it.skip;

describe(`管理面 ${N} 成员性能硬门（GX_PERF_GATE=1 启用）`, () => {
  perfGateIt("门控：通讯录三接口各自 warm p95 < 150ms（SPEC 宽松门）", async () => {
    const endpoints = [
      "/api/v1/org/members?page=1&limit=100",
      "/api/v1/org/departments",
      "/api/v1/org/roles",
    ];
    for (const url of endpoints) {
      const durations: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = performance.now();
        const res = await h.app.request(url, { headers: { Authorization: `Bearer ${ownerToken}` } });
        durations.push(performance.now() - t0);
        expect(res.status).toBe(200);
      }
      const warm = [...durations].sort((a, b) => a - b).slice(1); // 去首轮冷启动，与文件既有口径一致
      const p95 = percentile(warm, 95);
      console.log(`[S8 perf gate] ${url}: warmP95=${p95.toFixed(2)} ms (gate <150)`);
      expect(p95).toBeLessThan(150);
    }
  });
});
