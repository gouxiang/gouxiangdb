// S5b-P1 点引用环 characterization（S5b 计划 §5）：把环/钻石/跨表/链式现状锁成可复现 golden。
//
// 纪律：只锁现状、不判 bug、不动取值算法（hydrate.ts / hydrateBatch.ts 本片零字节改动）。
// 参与等值判定的只有「图结构 + 捕获值 + 拉取次数序列」；golden.provenance（commit/node）
// 仅是来源元数据，绝不进比对（§5.1），否则每次提交 / 多版本 CI 互打。
//
// 三桶（§5.3）：
//   P0 确定性必等桶；P1 依赖起始顺序的现状桶（桶间不等测试仍 pass，不等项见 golden
//   pendingDifferences「待裁决差异清单」）；P2 project off/shadow/on 三态占位（待 S5b-Ⅱ）。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hydrateRecords, hydrateRecordsLegacy } from "../hydrate.js";
import {
  buildRingStore, traceDeps,
  A_FA, A_LA, A_F7, B_FB, P_G1, P_G2, X_XF, Y_YF,
  type RingStore,
} from "./characterization/_ringFixture.js";

interface GoldenCapture {
  start: string;
  bucket: "P0" | "P1" | "P2";
  values: Record<string, unknown>[];
  fetchSequence: string[];
  peerFetchCounts: Record<string, number>;
}
interface Golden {
  graph: { edges: unknown[]; formulas: Record<string, string> };
  captures: Record<"batch" | "legacy", Record<string, GoldenCapture>>;
  buckets: Record<"P0" | "P1" | "P2", string[]>;
  pendingDifferences: { id: string }[];
  knownBoundaries: { id: string }[];
  provenance: unknown;
}

const goldenPath = fileURLToPath(new URL("./__snapshots__/hydrate-ring-golden.json", import.meta.url));
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as Golden;

const WATCH = new Set([A_FA, A_LA, A_F7, B_FB, P_G1, P_G2, X_XF, Y_YF, "dv", "dlup"]);
const ALL_IDS = ["a1", "a0", "b1", "b0", "c1", "p1", "p2", "d1", "x1", "y1"];

/** 据实跑一条捕获（与 golden 同形状）；mode 决定批量路径或 legacy 串行路径。 */
async function capture(s: RingStore, startIds: string[], mode: "batch" | "legacy"): Promise<GoldenCapture> {
  const deps = traceDeps(s);
  const rows = startIds.map((id) => s.store.find((r) => r.id === id)!);
  const run = mode === "batch" ? hydrateRecords : hydrateRecordsLegacy;
  const out = await run(rows, s.fieldsByTable[rows[0]!.tableId]!, deps);
  const values = out.map((r) => ({
    id: r.id,
    ...Object.fromEntries(Object.keys(r.fields).filter((k) => WATCH.has(k)).map((k) => [k, r.fields[k]])),
  }));
  const fetchSequence = deps.events
    .filter((e) => e.op !== "fields")
    .map((e) => (e.op === "records" ? `rec[${(e.ids ?? []).join(",")}]` : `link(${e.linkFieldId})`));
  const peerFetchCounts = Object.fromEntries(
    ALL_IDS.map((id) => [id, deps.events.reduce((n, e) => n + (e.op === "records" && e.ids?.includes(id) ? 1 : 0), 0)]),
  );
  return { start: startIds.join(","), bucket: "P0", values, fetchSequence, peerFetchCounts };
}

function scenarioIds(mode: "batch" | "legacy"): [string, GoldenCapture][] {
  return Object.entries(golden.captures[mode]);
}

/** 由 golden.buckets 反查某 (mode,场景) 的桶标注。 */
function bucketOf(mode: string, key: string): "P0" | "P1" | "P2" {
  const tag = `${mode}:${key}`;
  return (["P0", "P1", "P2"] as const).find((b) => golden.buckets[b].includes(tag)) ?? "P1";
}

// ============ 图结构：参与比对，锁死环/钻石/跨表拓扑与公式文本 ============

describe("S5b-P1 golden 图结构（graph 进比对；provenance 不进）", () => {
  it("9 条 link 边、7 个点引用公式、2 个 lookup 拓扑锁定", () => {
    expect(golden.graph.edges).toHaveLength(9);
    expect(golden.graph.formulas).toEqual({
      "ring_a.fa": "{AB.fb}",
      "ring_a.f7": "{AB.BC.cv}",
      "ring_b.fb": "{BA.fa}",
      "ring_p.g1": "{PD.dv}",
      "ring_p.g2": "{PD.dv}",
      "ring_x.xf": "{Y.yf}",
      "ring_y.yf": "{X.xf}",
    });
  });

  it("provenance 存在但不进等值判定：比对对象只含 graph/captures/桶/清单", () => {
    expect(golden.provenance).toBeTruthy();
    const comparable = {
      graph: golden.graph,
      captures: golden.captures,
      buckets: golden.buckets,
      pendingDifferences: golden.pendingDifferences,
      knownBoundaries: golden.knownBoundaries,
    };
    expect(comparable).not.toHaveProperty("provenance");
  });
});

// batch 捕获只在 GX_HYDRATE_PREFETCH=on（NODE_ENV=test 默认）有意义；off 态 hydrateRecords
// 直接转 legacy，batch golden 不适用（off 回归由下面的 legacy 表驱动 describe 承担）。
const describeBatch = describe.skipIf(process.env.GX_HYDRATE_PREFETCH === "off");

// ============ 批量路径（GX_HYDRATE_PREFETCH=on 默认）逐场景对拍 golden ============

describeBatch("R3/R4/R6/R2/自身 lookup（batch，默认 on）—— 现状逐值+序列锁死", () => {
  for (const [key, g] of scenarioIds("batch")) {
    it(`[${bucketOf("batch", key)}] batch:${key} 捕获值与拉取序列 == golden`, async () => {
      const s = buildRingStore();
      const actual = await capture(s, g.start.split(","), "batch");
      expect(actual.values).toEqual(g.values);
      expect(actual.fetchSequence).toEqual(g.fetchSequence);
      expect(actual.peerFetchCounts).toEqual(g.peerFetchCounts);
    });
  }
});

// ============ legacy 串行路径（GX_HYDRATE_PREFETCH=off 回退分支）逐场景对拍 ============

describe("legacy 串行回退分支 —— 取值与 batch 全等，触底序列按 N+1 现状锁定", () => {
  for (const [key, g] of scenarioIds("legacy")) {
    it(`[${bucketOf("legacy", key)}] legacy:${key} 捕获值与拉取序列 == golden`, async () => {
      const s = buildRingStore();
      const actual = await capture(s, g.start.split(","), "legacy");
      expect(actual.values).toEqual(g.values);
      expect(actual.fetchSequence).toEqual(g.fetchSequence);
      expect(actual.peerFetchCounts).toEqual(g.peerFetchCounts);
    });
  }
});

// ============ R3 非对称环：三起始态专项（桶间不等仍 pass，差异归清单 D1） ============

describeBatch("R3 非对称点引用环 A.fa<->B.fb（三起始态）", () => {
  it("A 根：fa=null（环置空），且同记录无关 lookup la 仍取 [7]（环不波及，R6）", async () => {
    const s = buildRingStore();
    const c = await capture(s, ["a1"], "batch");
    expect(c.values[0]).toMatchObject({ id: "a1", fa: null, la: [7] });
  });

  it("B 根：fb=null；无关 B 记录 b0：fb=null 且零 records 触底（仅元数据 link 查询）", async () => {
    const s1 = buildRingStore();
    const cb = await capture(s1, ["b1"], "batch");
    expect(cb.values[0]).toMatchObject({ id: "b1", fb: null });
    const s2 = buildRingStore();
    const c0 = await capture(s2, ["b0"], "batch");
    expect(c0.values[0]).toMatchObject({ id: "b0", fb: null });
    expect(c0.peerFetchCounts).toEqual(
      Object.fromEntries(ALL_IDS.map((id) => [id, 0])),
    );
  });

  it("三起始态环值无分叉（全 null）；起始顺序差异仅在拉取序列，登记 D1 而非判失败", () => {
    expect(["D1"]).toEqual(golden.pendingDifferences.filter((d) => d.id === "D1").map((d) => d.id));
  });
});

const itBatch = it.skipIf(process.env.GX_HYDRATE_PREFETCH === "off");

// ============ R4 钻石：黑盒三断言（不加测试专用导出，§5.2） ============

describe("R4 钻石：共享子记录 d1 被 p1/p2 两条路径汇聚（黑盒）", () => {
  itBatch("两汇聚公式 g1/g2 在两行上取值相等且正确（=42）", async () => {
    const s = buildRingStore();
    const c = await capture(s, ["p1", "p2"], "batch");
    expect(c.values).toEqual([
      { id: "p1", g1: 42, g2: 42 },
      { id: "p2", g1: 42, g2: 42 },
    ]);
  });

  itBatch("去重后 d1 底层 records 触底恰 1 次（prefetch/title/点引 merged 共用请求级缓存）", async () => {
    const s = buildRingStore();
    const c = await capture(s, ["p1", "p2"], "batch");
    expect(c.peerFetchCounts.d1).toBe(1);
  });

  it("注：顶层 hydrateOne 不查 mergedCache，单次物化只体现在点引 getMergedCached(hydrate.ts:420) 命中", async () => {
    // legacy 无请求级 prefetch 去重：d1 触底 3（p1 title + p1 点引物化 + p2 title），
    // 而 p1.g2 与 p2.g1/g2 命中 mergedCache（否则 ≥4）。黑盒以 golden 触底数锁定该形状。
    const s = buildRingStore();
    const c = await capture(s, ["p1", "p2"], "legacy");
    expect(c.peerFetchCounts.d1).toBe(3);
    expect(golden.captures.legacy["r4-diamond"]!.peerFetchCounts.d1).toBe(3);
  });
});

// ============ R2 双侧 null 环 + d1 自身 lookup ============

describeBatch("R2 双侧点引用环 / d1 自身 lookup", () => {
  it("x1.xf=null、y1.yf=null（两侧互不炸、不死循环）", async () => {
    const sx = buildRingStore();
    const cx = await capture(sx, ["x1"], "batch");
    expect(cx.values[0]).toMatchObject({ id: "x1", xf: null });
    const sy = buildRingStore();
    const cy = await capture(sy, ["y1"], "batch");
    expect(cy.values[0]).toMatchObject({ id: "y1", yf: null });
  });

  it("d1 自身：物理 dv=42，lookup dlup=[7]（环外叶子链路正常）", async () => {
    const s = buildRingStore();
    const c = await capture(s, ["d1"], "batch");
    expect(c.values[0]).toMatchObject({ id: "d1", dv: 42, dlup: [7] });
  });
});

// ============ R7 链式首点：已知能力边界，非缺陷（§5.6） ============

describeBatch("R7 链式 {a.b.c} 只切首点 -> null【已知能力边界，非缺陷】", () => {
  it("a1.f7={AB.BC.cv} 现状 subName='BC.cv' 在 B 表无同名字段 -> null（bc 边 b1->c1, cv=7 真实存在）", async () => {
    const s = buildRingStore();
    const c = await capture(s, ["a1"], "batch");
    expect(c.values[0]).toMatchObject({ id: "a1", f7: null });
    expect(golden.knownBoundaries.map((b) => b.id)).toContain("R7");
  });
});

// ============ P2：project off/shadow/on 三态参数化占位（待 S5b-Ⅱ，现在不写适配代码） ============

describe.skip("P2 字段投影器三态（待 S5b-Ⅱ；本切片不写任何 GX_HYDRATE_PROJECT 适配代码）", () => {
  it("project=off：环 golden 逐值全等（默认现状）", () => {
    // TODO(S5b-Ⅱ)：GX_HYDRATE_PROJECT=off 跑本文件全部捕获，values 必须与 golden 全等。
  });
  it("project=shadow：响应取全量值，投影值并行对拍 drift=0（含全部环夹具）", () => {
    // TODO(S5b-Ⅱ)：shadow 态 drift 必须为 0，是翻 on 的硬门槛（计划 §3.4-3）。
  });
  it("project=on：环/钻石/链式/跨表逐值 == golden，环回退有计数不静默", () => {
    // TODO(S5b-Ⅱ)：on 态点引走投影批波；环维持 null；R7 若变真两跳即 golden drift，走差异流程。
  });
});
