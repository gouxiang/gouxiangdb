// M4/S6 裁决 A-4 四专项（on 态端到端，真库真 HTTP）：
//   专项1 LinkRef 两档（表级 r+字段 mask -> title 回退真实 recordId；表级不可见 -> 引用整体缺席）；
//   专项2 中性文案（①档响应不出现"无权限"三字，title 是真实 id 而非伪造空串）；
//   专项3 公式 mask-null 不可区分（真空 null vs 有值被 mask：结果与错误文案逐字节一致，零新求值分支）；
//   专项4 mask null 不改变排序/分组/聚合桶（可见字段视图在 mask 与全可见两视角逐值一致；
//         M1 flags 四组合 read off/on x keyset off/on 投影结果不漂移）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { json } from "../../nav/__tests__/characterization/charHarness.js";
import { setupS6MaskFixture, OWNER, MASK, type S6Fixture } from "./s6MaskHarness.js";

let fx: S6Fixture;

beforeAll(async () => {
  fx = await setupS6MaskFixture();
}, 120000);

afterAll(async () => {
  delete process.env.GX_M1_SIDECAR_READ;
  delete process.env.GX_M1_KEYSET;
  await fx.h.cleanup();
});

beforeEach(() => {
  process.env.GX_M1_SIDECAR_READ = "off";
  process.env.GX_M1_KEYSET = "off";
});

interface CellRecord { id: string; fields: Record<string, unknown> }
interface ListBody {
  records: CellRecord[];
  groups: Array<{ key: string; label: string; recordIds: string[]; aggregations: Record<string, number | null> }> | null;
  aggregations: Record<string, number | null> | null;
}

async function listA(user: string, tail = ""): Promise<ListBody> {
  const res = await fx.call("GET", `/api/records?tableId=${fx.A}${tail}`, user);
  expect(res.status).toBe(200);
  return json<ListBody>(res);
}

function record(body: ListBody, id: string): CellRecord {
  const r = body.records.find((x) => x.id === id);
  if (!r) throw new Error(`record ${id} absent`);
  return r;
}

// ============ 专项 1+2：LinkRef 两档 + 中性文案 ============

describe("A-4 专项1 LinkRef 两档（hydrate 源头收口）", () => {
  it("①档 tableB 表级 r 但展示字段被 mask：title=真实 recordId，body 无 id/title 之外的原值", async () => {
    const body = await listA(MASK);
    const a1 = record(body, fx.rec.A1);
    const refs = a1.fields[fx.f.cust] as Array<{ recordId: string; title: string; tableId: string }>;
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.map((r) => r.recordId).sort()).toEqual([fx.rec.B1, fx.rec.B2].sort());
    for (const r of refs) {
      // 无可见非空展示值 -> 以真实 recordId 为标题（非空、非伪造，不出现"无权限"措辞）
      expect(r.title).toBe(r.recordId);
      expect(r.tableId).toBe(fx.B);
      expect(JSON.stringify(r)).not.toContain("甲公司");
      expect(JSON.stringify(r)).not.toContain("乙公司");
      expect(JSON.stringify(r)).not.toContain("无权限");
    }
  });

  it("②档 tableC 表级完全不可见：LinkRef 整体缺席（[]，无 id/title/tableId 泄漏）", async () => {
    const body = await listA(MASK);
    const a1 = record(body, fx.rec.A1);
    expect(a1.fields[fx.f.deal]).toEqual([]); // 不是 [{recordId...}]，引用整体走不可见通道
    // owner 对照：真实存在 1 条 C1 关联
    const owner = await listA(OWNER);
    const ownerA1 = record(owner, fx.rec.A1);
    const deal = ownerA1.fields[fx.f.deal] as Array<{ recordId: string }>;
    expect(deal.map((r) => r.recordId)).toEqual([fx.rec.C1]);
  });

  it("②档连带：count 归零、lookup/rollup 取空（不借关联计数/取值泄漏对端存在性）", async () => {
    const body = await listA(MASK);
    const a1 = record(body, fx.rec.A1);
    expect(a1.fields[fx.f.countC]).toBe(0);
    // B 表可见：countB=2（A1 挂 B1/B2），lookup 被 mask 的公司名 -> 空数组，rollup 被 mask 金额 -> null
    expect(a1.fields[fx.f.countB]).toBe(2);
    expect(a1.fields[fx.f.lookupName]).toEqual([]);
    expect(a1.fields[fx.f.rollupAmt]).toBeNull();
  });
});

// ============ 专项 3：公式 mask-null 不可区分 ============
//
// 原理（零新求值分支）：掩码字段不进 hydrate 字段表 -> merged 中该键缺席 -> buildFormulaSource
// 对缺席键返回 FNULL，与该列【真实存了 null】走完全相同的既有路径。A1 薪资真空 null，
// A2 薪资有值 888 但被 mask——u_mask 视角两者的 8 个公式结果必须逐字节一致。

describe("A-4 专项3 公式 mask-null 与真空值不可区分", () => {
  const FORMULAS: Array<[keyof S6Fixture["f"], string]> = [
    ["fmRef", "直接引用"], ["fmSum", "SUM"], ["fmAvg", "AVERAGE"], ["fmMin", "MIN"],
    ["fmMax", "MAX"], ["fmConcat", "CONCAT"], ["fmArith", "算术"], ["fmIsNull", "ISNULL"],
  ];

  it("A1(真空 null) 与 A2(888 被 mask) 在 8 个公式上结果逐字节一致", async () => {
    const body = await listA(MASK);
    const a1 = record(body, fx.rec.A1);
    const a2 = record(body, fx.rec.A2);
    for (const [key, label] of FORMULAS) {
      expect(a2.fields[fx.f[key]], label).toEqual(a1.fields[fx.f[key]]);
    }
    // 锁死具体取值（防"两边都算错但恰好相等"的沉默偏差）：
    expect(a1.fields[fx.f.fmIsNull]).toBe(true); // ISNULL(null)=true
    expect(a1.fields[fx.f.fmRef]).toBeNull();
    expect(a1.fields[fx.f.fmSum]).toBe(0);
    expect(a1.fields[fx.f.fmAvg]).toBe(0);
    expect(a1.fields[fx.f.fmMin]).toBe(0);
    expect(a1.fields[fx.f.fmMax]).toBe(0);
    expect(a1.fields[fx.f.fmConcat]).toBe("n=");
    // {薪资}*2 -> FNULL；FNULL + 1 走既有的字符串回退分支 -> "" + "1" = "1"
    //（这是 null 算术语义现状，真空与 mask-null 走同一分支同结果，并非新掩码分支）。
    expect(a1.fields[fx.f.fmArith]).toBe("1");
  });

  it("owner 视角 A2 公式按真实 888 求值（证明 on 态差异确实来自 mask 而非公式坏了）", async () => {
    const body = await listA(OWNER);
    const a2 = record(body, fx.rec.A2);
    expect(a2.fields[fx.f.fmRef]).toBe(888);
    expect(a2.fields[fx.f.fmSum]).toBe(888);
    expect(a2.fields[fx.f.fmIsNull]).toBe(false);
    expect(a2.fields[fx.f.fmConcat]).toBe("n=888");
    expect(a2.fields[fx.f.fmArith]).toBe(1777);
  });

  it("跨表点引用：对端金额被 mask 的 SUM 与无关联/真空不可区分；无 mask 错误分支文案", async () => {
    const body = await listA(MASK);
    const a1 = record(body, fx.rec.A1);
    const a3 = record(body, fx.rec.A3); // 无关联
    // A1 挂 B1(100)/B2(200) 但金额列被 mask -> 与 A3 无关联同形（空集求和 0）
    expect(a1.fields[fx.f.dotSum]).toBe(0);
    expect(a3.fields[fx.f.dotSum]).toBe(0);
    // 错误通道零使用：响应文本无任何掩码相关错误/提示串
    const raw = JSON.stringify(a1.fields);
    expect(raw).not.toContain("无权限");
    expect(raw).not.toContain("无权");
    expect(raw).not.toContain("掩码");
  });
});

// ============ 专项 4：mask null 不改变排序/分组/聚合桶 + M1 四组合 ============

describe("A-4 专项4 掩码不改变可见字段的排序/分组/聚合", () => {
  it("name 排序/分组/计数视图：mask 与 owner 两视角 recordId 序列与桶一致（3 行）", async () => {
    // 建只引用可见 name 的视图
    const vp = await fx.call("POST", `/api/views?tableId=${fx.A}`, OWNER, {
      name: "visible-name", type: "grid",
      config: {
        sorts: [{ fieldId: fx.f.name, direction: "asc" }],
        groupByFieldId: fx.f.name,
        aggregations: { [fx.f.name]: "countFilled" },
      },
    });
    const vid = (await json<{ view: { id: string } }>(vp)).view.id;

    const masked = await listA(MASK, `&viewId=${vid}&limit=1000`);
    const owner = await listA(OWNER, `&viewId=${vid}&limit=1000`);
    expect(masked.records.map((r) => r.id)).toEqual(owner.records.map((r) => r.id));
    expect(masked.records.map((r) => r.fields[fx.f.name]))
      .toEqual(owner.records.map((r) => r.fields[fx.f.name]));
    // 每名单个桶，桶内计数 1，桶键不含被 mask 的薪资
    expect(masked.groups).not.toBeNull();
    expect(masked.groups!.map((g) => g.key).sort()).toEqual(owner.groups!.map((g) => g.key).sort());
    for (const g of masked.groups!) {
      expect(g.aggregations[fx.f.name]).toBe(1);
      expect(Object.keys(g.aggregations)).not.toContain(fx.f.salary);
    }
  });

  it("借隐藏薪资的视图：mask 视角 groups=null、aggregations 仅可见列、行不被隐藏 filter 收窄", async () => {
    const body = await listA(MASK, `&viewId=${fx.viewA}&limit=1000`);
    expect(body.groups).toBeNull(); // 隐藏 groupByFieldId -> 脱敏置 null -> 不产掩码桶
    expect(body.aggregations).not.toBeNull();
    expect(Object.keys(body.aggregations!)).toEqual([fx.f.name]);
    expect(body.records).toHaveLength(3); // 隐藏 isNotEmpty filter 被抹掉 -> 不过滤
    const owner = await listA(OWNER, `&viewId=${fx.viewA}&limit=1000`);
    // owner 视角该 filter 生效，薪资为空的 A1 被滤掉
    expect(owner.records.map((r) => r.id).sort()).toEqual([fx.rec.A2, fx.rec.A3].sort());
  });
});

describe("A-4 专项4 M1 flags 四组合回归（投影不随读路径漂移）", () => {
  const combos: Array<[string, string, string]> = [
    ["read=off", "off", "off"],
    ["read=on/keyset=off", "on", "off"],
    ["read=on/keyset=on", "on", "on"],
    // keyset=on 但 read=off：keysetPagingActive 恒 false（防绕过读灰度），等价旧路径
    ["read=off/keyset=on(不生效)", "off", "on"],
  ];

  for (const [label, read, keyset] of combos) {
    it(`${label}：隐藏列缺席/行集合/①档 title 一致`, async () => {
      process.env.GX_M1_SIDECAR_READ = read;
      process.env.GX_M1_KEYSET = keyset;
      const body = await listA(MASK);
      expect(body.records).toHaveLength(3);
      for (const r of body.records) {
        expect(r.fields).not.toHaveProperty(fx.f.salary);
        expect(r.fields).not.toHaveProperty(fx.f.secret);
      }
      const a1 = record(body, fx.rec.A1);
      const refs = a1.fields[fx.f.cust] as Array<{ recordId: string; title: string }>;
      expect(refs.map((r) => r.title)).toEqual(refs.map((r) => r.recordId));
      expect(a1.fields[fx.f.deal]).toEqual([]);
    });
  }
});
