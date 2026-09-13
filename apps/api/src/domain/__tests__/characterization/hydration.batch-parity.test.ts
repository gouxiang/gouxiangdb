// M1/S0 Characterization：hydration 复杂夹具「逐值快照」+ 取数批次基线
//
// 双目的：
//  1) 逐值锁死：多表 + 正向/反向 links + lookup/rollup/count + 链式公式 + 点引用
//     + 双向环 + 同表自引用，在当前 hydrate 引擎下每条记录的完整 fields 映射。
//     M1 S5「批量化两阶段预取」必须与本快照逐值 deep-equal（行为锁死，只许改取数编排）。
//  2) 批次基线：计数 deps 记录每种取数方法的调用次数与批量大小分布。
//     现状是逐行/逐字段 N+1（getRecordsByIds=19 / getLinkRows=20）；S5 后这些计数应
//     显著下降（届时只更新计数断言），但上方逐值快照必须一字不差保持一致。
//
// Characterization 纪律：快照由当前引擎真实产出后人工核对落盘，不修正任何怪癖。
// 夹具定义见同目录 _hydrationFixture.ts（不计入测试文件）。

import { describe, it, expect } from "vitest";
import { hydrateRecords, hydrateRecordsLegacy, type HydrateDeps } from "../../hydrate.js";
import type { HydratedRecord } from "../../types.js";
import {
  T, empFields, xFields, yFields,
  E_MGR, E_REPORTS, E_DEPTNAME, E_DEPTSUM, E_DEPTCOUNT, E_DOT, X_F, Y_F,
  buildStore, countingDeps,
} from "./_hydrationFixture.js";

async function hydrateEmp(): Promise<{ out: HydratedRecord[]; counts: ReturnType<typeof countingDeps>["counts"] }> {
  const { store, links } = buildStore();
  const deps = countingDeps(store, links);
  const out = await hydrateRecords(
    store.filter((r) => r.tableId === T.emp),
    empFields,
    deps as HydrateDeps,
  );
  return { out, counts: deps.counts };
}

/** 旧逐行串行实现（A 基线）：单独跑一次取计数，快照值与上方 batch 路径共用同一份 inline 快照。 */
async function hydrateEmpLegacy(): Promise<ReturnType<typeof countingDeps>["counts"]> {
  const { store, links } = buildStore();
  const deps = countingDeps(store, links);
  const out = await hydrateRecordsLegacy(
    store.filter((r) => r.tableId === T.emp),
    empFields,
    deps as HydrateDeps,
  );
  // 顺带锁死：旧实现产出与逐值快照结构一致（sanity，真值由上面 batch 的 inline 快照对拍）。
  expect(out).toHaveLength(3);
  return deps.counts;
}

describe("员工表逐值快照（正/反向 links, lookup, rollup, count, 链式公式, 点引用, 自引用）", () => {
  it("三条员工记录完整 fields 映射锁定", async () => {
    const { out } = await hydrateEmp();
    const map = Object.fromEntries(out.map((r) => [r.id, r.fields]));
    expect(map).toMatchInlineSnapshot(`
      {
        "emp1": {
          "e_dept": [
            {
              "recordId": "dept1",
              "tableId": "t_dept",
              "title": "研发部",
            },
          ],
          "e_deptcount": 1,
          "e_deptname": [
            "研发部",
          ],
          "e_deptsum": 1000,
          "e_dot": 1000,
          "e_mgr": [
            {
              "recordId": "emp2",
              "tableId": "t_emp",
              "title": "李四",
            },
            {
              "recordId": "emp3",
              "tableId": "t_emp",
              "title": "王五",
            },
          ],
          "e_name": "张三",
          "e_reports": [],
          "e_sal": 200,
          "e_t": "张三:200",
          "e_t2": "张三:200!",
        },
        "emp2": {
          "e_dept": [
            {
              "recordId": "dept1",
              "tableId": "t_dept",
              "title": "研发部",
            },
          ],
          "e_deptcount": 1,
          "e_deptname": [
            "研发部",
          ],
          "e_deptsum": 1000,
          "e_dot": 1000,
          "e_mgr": [],
          "e_name": "李四",
          "e_reports": [
            {
              "recordId": "emp1",
              "tableId": "t_emp",
              "title": "张三",
            },
          ],
          "e_sal": 300,
          "e_t": "李四:300",
          "e_t2": "李四:300!",
        },
        "emp3": {
          "e_dept": [
            {
              "recordId": "dept2",
              "tableId": "t_dept",
              "title": "市场部",
            },
          ],
          "e_deptcount": 1,
          "e_deptname": [
            "市场部",
          ],
          "e_deptsum": 500,
          "e_dot": 500,
          "e_mgr": [],
          "e_name": "王五",
          "e_reports": [
            {
              "recordId": "emp1",
              "tableId": "t_emp",
              "title": "张三",
            },
          ],
          "e_sal": 150,
          "e_t": "王五:150",
          "e_t2": "王五:150!",
        },
      }
    `);
  });

  it("点引用经对端记录取保留类型的数值：单关联为标量 number（非字符串）", async () => {
    const { out } = await hydrateEmp();
    const v = out.find((r) => r.id === "emp1")!.fields[E_DOT];
    expect(v).toBe(1000);
    expect(typeof v).toBe("number");
  });

  it("lookup 始终返回数组；rollup 标量；count 数字", async () => {
    const { out } = await hydrateEmp();
    const emp3 = out.find((r) => r.id === "emp3")!;
    expect(emp3.fields[E_DEPTNAME]).toEqual(["市场部"]);
    expect(emp3.fields[E_DEPTSUM]).toBe(500);
    expect(emp3.fields[E_DEPTCOUNT]).toBe(1);
  });

  it("同表自引用：正向取下属、反向取经理，不跨表串数据", async () => {
    const { out } = await hydrateEmp();
    const byId = Object.fromEntries(out.map((r) => [r.id, r]));
    expect((byId.emp1.fields[E_MGR] as { recordId: string }[]).map((x) => x.recordId)).toEqual(["emp2", "emp3"]);
    expect(byId.emp2.fields[E_REPORTS]).toEqual([{ tableId: T.emp, recordId: "emp1", title: "张三" }]);
  });
});

describe("双向点引用环：不无限递归，环上公式置 null", () => {
  it("X1 与 Y1 互相点引用对方公式 → 两侧均 null，且快速返回", async () => {
    const { store, links } = buildStore();
    const start = Date.now();
    const xs = await hydrateRecords(store.filter((r) => r.tableId === T.x), xFields, countingDeps(store, links));
    expect(xs.find((r) => r.id === "x1")!.fields[X_F]).toBeNull();
    const ys = await hydrateRecords(store.filter((r) => r.tableId === T.y), yFields, countingDeps(store, links));
    expect(ys.find((r) => r.id === "y1")!.fields[Y_F]).toBeNull();
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe("取数批次：A 旧串行 N+1 基线 vs B 两阶段常量（M1/S5）", () => {
  it("A：legacy 锁死 getFields/getRecordsByIds/getLinkRows=1/19/20 精确形状", async () => {
    const counts = await hydrateEmpLegacy();
    // 改造前（2026-09-13，三员工 + 两部门 + 自引用夹具）实测：
    //   本表 fields 由调用方传入，getFields 仅因跨表发生一次；
    //   getRecordsByIds=19、getLinkRows=20 为逐行/逐字段 N+1 真实形状。
    expect(counts.getFields).toBe(1);
    expect(counts.getRecordsByIds).toBe(19);
    expect(counts.getLinkRows).toBe(20);
    expect(counts.countLinkRows).toBe(0);
    expect(counts.recordBatchSizes).toEqual([1, 2, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(counts.linkBatchSizes).toEqual([1, 2, 0, 1, 1, 1, 2, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1]);
    expect(counts.recordBatchSizes.filter((n) => n === 1).length).toBe(17);
  });

  // GX_HYDRATE_PREFETCH=off 时 hydrateRecords 明确回退 legacy（19/20），常量形状不成立 → 跳过；
  // A/legacy 与逐值快照两态都跑。
  const itBatch = it.skipIf(process.env.GX_HYDRATE_PREFETCH === "off");
  itBatch("B：两阶段批量化把 getRecordsByIds/getLinkRows 收敛为常量（不随页内 N 线性涨）", async () => {
    const { counts } = await hydrateEmp();
    // 改造后（BatchStore BFS 预热 + 组级去重，同一夹具，注入计数 deps 无 bulk 实现）：
    //   getRecordsByIds=1（对端 dept 一条 IN；emp 自引用根记录已在缓存，0 额外查询）；
    //   getLinkRows=2（= 夹具里不同的正向 linkFieldId 数：e_dept、e_mgr 各整查一次；
    //     正/反方向共享同字段一次查询，跨层环上的重复组由 wholeLoaded/wholeLoading 去重，与行数无关）；
    //   getFields 仍 1；本表无 createdBy/lastModifiedBy 系统字段 → resolveUserName=0（与 legacy 对齐）。
    expect(counts.getFields).toBe(1);
    expect(counts.getRecordsByIds).toBe(1);
    expect(counts.getLinkRows).toBe(2);
    expect(counts.countLinkRows).toBe(0);
    expect(counts.resolveUserName).toBe(0);
    // 唯一一次记录 IN 一次取全 2 个对端部门（批大小 2），不再有 17 次单点查。
    expect(counts.recordBatchSizes).toEqual([2]);
    expect(counts.recordBatchSizes.every((n) => n > 1)).toBe(true);
    // 每次 linkRows 整查都带回该字段的全部行（3/2），而非逐行 [1,2,0,1,...] 的 N+1 形状。
    expect(counts.linkBatchSizes).toEqual([3, 2]);
  });
});
