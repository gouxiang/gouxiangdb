// apps/web/src/features/detail/form-versioning/tabs-snapshot.test.ts
// tabs-snapshot.ts（快照 tabs 段归一 / 还原）的单测。

import { describe, expect, it } from "vitest";
import type { TabConfig } from "@gx/shared-types";
import { buildTabsSnapshot, isEmptyTabsEntry, normalizeTabsEntry, restoreTabsConfig, tabFieldIdsOf, TABS_CLEAR_SUPPORTED } from "./tabs-snapshot";
import { parseSnapshot } from "./versioning";

describe("normalizeTabsEntry / tabFieldIdsOf", () => {
  it("bucket：cards + lazyTouched", () => {
    const e = normalizeTabsEntry({ cards: ["a", "b", "a"], lazyTouched: ["b"] });
    expect(e).toEqual({ kind: "bucket", cards: ["a", "b"], lazyTouched: ["b"] });
  });

  it("byTab：每个值都带 cards 才认", () => {
    const e = normalizeTabsEntry({ tabA: { cards: ["a"] }, tabB: { cards: ["b"] } });
    expect(e?.kind).toBe("byTab");
    expect(tabFieldIdsOf(e!)).toEqual(["a", "b"]);
  });

  it("config：TabConfig[] 原样保真", () => {
    const tabs: TabConfig[] = [{ id: "t1", name: "基本信息", fieldIds: ["a"] }];
    const e = normalizeTabsEntry(tabs);
    expect(e?.kind).toBe("config");
    expect(tabFieldIdsOf(e!)).toEqual(["a"]);
  });

  // 后端 formLayoutSnapshot.ts:169 normalizeTabs 的落库形态是**带 cards 的对象**：
  // { cards, lazyTouched, tabs?: TabConfig[] }。若判定顺序让 cards 抢在 tabs 之前，
  // 整段结构快照会被忽略、降级成 bucket —— 回退退化为按当前骨架重建，
  // 宽度占比与用户 ▼ 拆出的行边界全丢（"假回退"）。这条锁死"先 tabs 后 cards"。
  it("后端线形态：{ cards, lazyTouched, tabs } 必须走 config，不能被 cards 降级", () => {
    const e = normalizeTabsEntry({
      cards: ["f1"],
      lazyTouched: [],
      tabs: [
        {
          id: "t1",
          name: "基本信息",
          fieldIds: ["f1"],
          widths: { f1: 75 },
          rows: [{ items: [{ fieldId: "f1", widthPct: 75 }] }],
        },
      ],
    })!;
    expect(e.kind).toBe("config");
    // 走 config 还原：页 id / 宽度 / 行边界都要原样回来
    const out = restoreTabsConfig(e, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("t1");
    expect(out[0]!.widths).toEqual({ f1: 75 });
    expect(out[0]!.rows).toEqual([{ items: [{ fieldId: "f1", widthPct: 75 }] }]);
  });

  it("tabs 为空数组：不进 config 分支，按老信封语义退化成 bucket", () => {
    const withCards = normalizeTabsEntry({ cards: ["a"], lazyTouched: [], tabs: [] })!;
    expect(withCards.kind).toBe("bucket");

    // 空容器在真实信封里就是这个样子（后端只在非空时落 tabs 键），它同样要被判成"0 页"
    const empty = normalizeTabsEntry({ cards: [], lazyTouched: [], tabs: [] })!;
    expect(empty.kind).toBe("bucket");
    expect(isEmptyTabsEntry(empty)).toBe(true);
  });

  it("认不出来的形状返回 null", () => {
    expect(normalizeTabsEntry(undefined)).toBeNull();
    expect(normalizeTabsEntry({ foo: 1 })).toBeNull();
  });
});


describe("restoreTabsConfig", () => {
  const skeleton: TabConfig[] = [
    { id: "tab1", name: "基本信息", fieldIds: ["a", "b"], widths: { a: 50, b: 50 } },
    { id: "tab2", name: "附件", fieldIds: ["c"], widths: { c: 100 } },
  ];

  it("config 形态：原样保真，连 rows 一起回来", () => {
    const entry = normalizeTabsEntry([{ id: "tab9", name: "自定义", fieldIds: ["z"], rows: [{ items: [{ fieldId: "z", widthPct: 100 }] }] }])!;
    const out = restoreTabsConfig(entry, skeleton);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("tab9");
    expect(out[0]!.rows).toHaveLength(1);
  });

  it("bucket 形态：以当前骨架为底，保留页 id / 页名 / 宽度，快照内容回填", () => {
    const entry = normalizeTabsEntry({ cards: ["c", "a"], lazyTouched: [] })!;
    const out = restoreTabsConfig(entry, skeleton);
    expect(out.map((t) => t.id)).toEqual(["tab1", "tab2"]);
    expect(out[0]!.fieldIds).toEqual(["a"]);
    expect(out[1]!.fieldIds).toEqual(["c"]);
    expect(out[0]!.widths).toEqual({ a: 50 });
  });

  it("保留字段原本所在的行与宽度（不把行边界拍平）", () => {
    const withRows: TabConfig[] = [
      {
        id: "tab1",
        name: "基本信息",
        fieldIds: ["a", "b"],
        widths: { a: 25, b: 75 },
        rows: [{ items: [{ fieldId: "a", widthPct: 25 }] }, { items: [{ fieldId: "b", widthPct: 75 }] }],
      },
    ];
    const out = restoreTabsConfig(normalizeTabsEntry({ cards: ["a", "b"] })!, withRows);
    expect(out[0]!.rows).toEqual([{ items: [{ fieldId: "a", widthPct: 25 }] }, { items: [{ fieldId: "b", widthPct: 75 }] }]);
  });

  it("快照里多出来的字段追加到末行（不是插到中间打乱行）", () => {
    const withRows: TabConfig[] = [
      { id: "tab1", name: "n", fieldIds: ["a"], widths: { a: 50 }, rows: [{ items: [{ fieldId: "a", widthPct: 50 }] }] },
    ];
    const out = restoreTabsConfig(normalizeTabsEntry({ cards: ["a", "new"] })!, withRows);
    expect(out[0]!.rows).toHaveLength(2);
    expect(out[0]!.rows?.[1]?.items.map((i) => i.fieldId)).toEqual(["new"]);
    // 快照里没给宽度的新字段按 50 兜底，不是 undefined
    expect(out[0]!.widths?.new).toBe(50);
  });

  it("快照里有、但当前骨架里没有归属的字段 -> 追加到第一页（不丢字段）", () => {
    const entry = normalizeTabsEntry({ cards: ["brandNew"] })!;
    const out = restoreTabsConfig(entry, skeleton);
    expect(out[0]!.fieldIds).toEqual(["brandNew"]);
    expect(out[1]!.fieldIds).toEqual([]);
  });

  it("当前没有骨架时造一个兜底页，不返回空数组把内容吞掉", () => {
    const out = restoreTabsConfig(normalizeTabsEntry({ cards: ["a", "b"] })!, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.fieldIds).toEqual(["a", "b"]);
    expect(out[0]!.name).toBeTruthy();
  });

  it("空快照（cards 为空）返回空数组，不拿骨架去冒充历史内容", () => {
    expect(restoreTabsConfig(normalizeTabsEntry({ cards: [] })!, skeleton)).toEqual([]);
  });

  it("byTab 形态按页聚合后再回填", () => {
    const entry = normalizeTabsEntry({ tab1: { cards: ["a"] }, tab2: { cards: ["c"] } })!;
    const out = restoreTabsConfig(entry, skeleton);
    expect(out[0]!.fieldIds).toEqual(["a"]);
    expect(out[1]!.fieldIds).toEqual(["c"]);
  });
});


describe("buildTabsSnapshot（回写后端信封用的 tabs 段 · 线上形态）", () => {
  it("值是对象：cards 展平 + tabs 结构数组（后端 normalizeTabs 只认对象，裸数组会被整条丢掉）", () => {
    const out = buildTabsSnapshot({
      f1: [
        { id: "t1", name: "基本信息", fieldIds: ["a", "b"] },
        { id: "t2", name: "附件", fieldIds: ["c"] },
      ],
    });
    expect(out).toEqual({
      f1: {
        cards: ["a", "b", "c"],
        lazyTouched: [],
        tabs: [
          { id: "t1", name: "基本信息", fieldIds: ["a", "b"] },
          { id: "t2", name: "附件", fieldIds: ["c"] },
        ],
      },
    });
    // 裸数组会被后端 isPlainObject 判否 -> 整条丢失，这里锁死"必须是对象"
    expect(Array.isArray(out.f1)).toBe(false);
  });

  it("宽度与行边界必须随信封走（这两样丢了 = 假回退）", () => {
    const out = buildTabsSnapshot({
      f1: [
        {
          id: "t1",
          name: "基本信息",
          fieldIds: ["a", "b"],
          widths: { a: 25, b: 75 },
          rows: [{ items: [{ fieldId: "a", widthPct: 25 }] }, { items: [{ fieldId: "b", widthPct: 75 }] }],
        },
      ],
    });
    expect(out.f1!.tabs![0]!.widths).toEqual({ a: 25, b: 75 });
    expect(out.f1!.tabs![0]!.rows).toHaveLength(2);
  });

  it("空的 widths / rows 一律省略，不塞空壳占位（信封契约）", () => {
    const out = buildTabsSnapshot({ f1: [{ id: "t1", name: "n", fieldIds: ["a"], widths: {}, rows: [] }] });
    expect("widths" in out.f1!.tabs![0]!).toBe(false);
    expect("rows" in out.f1!.tabs![0]!).toBe(false);
  });

  /**
   * 与后端 `detailLayout.test.ts` 那条端到端断言**同口径**（两端都钉这个形状）：
   * 空容器写进信封后**严格只有 cards / lazyTouched 两个键**，没有 tabs 键。
   * 前端 `isEmptyTabsEntry`、后端"空数组进信封就没了"两边都依赖这个形状，
   * 谁手一抖让空容器带上 `tabs: []`，两端会各自转红，不会出现只有一边静默漂移。
   */
  it("容器无内容时只写空 cards，不写空的 tabs 数组（与老信封字节兼容）", () => {
    const out = buildTabsSnapshot({ f1: [] });
    expect(out.f1).toEqual({ cards: [], lazyTouched: [] });
    expect("tabs" in out.f1!).toBe(false);
    expect(Object.keys(out.f1!).sort()).toEqual(["cards", "lazyTouched"]);
  });

  it("空容器经 JSON 往返后键集合不变（信封序列化不是判据的盲区）", () => {
    const envelope = JSON.parse(JSON.stringify(buildTabsSnapshot({ f1: [] }))) as Record<string, Record<string, unknown>>;
    expect(Object.keys(envelope.f1!).sort()).toEqual(["cards", "lazyTouched"]);
    const parsed = parseSnapshot({ version: 1, layout: null, tabs: envelope })!;
    expect(isEmptyTabsEntry(parsed.tabs!.f1!)).toBe(true);
  });

  it("产出的形状回填进信封后能被 normalizeTabsEntry 认成 config（最高保真档）", () => {
    const out = buildTabsSnapshot({ f1: [{ id: "t1", name: "n", fieldIds: ["a"] }] });
    expect(normalizeTabsEntry(out.f1)?.kind).toBe("config");
  });

  it("没有页 id 的 TabConfig 不能进结构数组（回退时无法归位）", () => {
    const out = buildTabsSnapshot({ f1: [{ id: "", name: "无 id", fieldIds: ["a"] }] });
    expect(out.f1!.tabs).toBeUndefined();
    expect(out.f1!.cards).toEqual([]);
  });

  it("没有容器时是空对象，不是 null（后端对 tabs 缺省用 {} 而非 null）", () => {
    expect(buildTabsSnapshot({})).toEqual({});
  });
});

describe("isEmptyTabsEntry（目标版本里这个容器是 0 页）", () => {
  /**
   * 真实信封里的"空容器"是 `{ cards: [], lazyTouched: [] }` —— **没有 tabs 键**。
   * 后端三个产路口（`formLayoutSnapshot.ts` / `formLayoutVersion.ts` / 净化）都是
   * "非空才落 tabs 键"，所以 `tabs: []` 这种形态库里根本不存在；判据必须覆盖"没有 tabs 键"。
   * 只写 `tabs.length === 0` 会永远 false，回退那条分支今天测不出来、A1 上线那天才暴雷。
   */
  it("没有 tabs 键 + cards 为空 = 0 页（库里的真实形态）", () => {
    expect(isEmptyTabsEntry(normalizeTabsEntry({ cards: [], lazyTouched: [] })!)).toBe(true);
    expect(isEmptyTabsEntry(normalizeTabsEntry({ tabA: { cards: [] } })!)).toBe(true);
  });

  it("显式写了空的 tabs 数组，同样是 0 页", () => {
    expect(isEmptyTabsEntry(normalizeTabsEntry({ cards: [], lazyTouched: [], tabs: [] })!)).toBe(true);
    expect(isEmptyTabsEntry(normalizeTabsEntry([])!)).toBe(true);
  });

  it("有内容（扁平有字段 / 结构化有页）都不是 0 页", () => {
    expect(isEmptyTabsEntry(normalizeTabsEntry({ cards: ["a"] })!)).toBe(false);
    expect(isEmptyTabsEntry(normalizeTabsEntry([{ id: "t1", name: "n", fieldIds: ["a"] }])!)).toBe(false);
  });

  it("结构化里有页、哪怕页内暂时没字段，也不是 0 页（分页本身还在）", () => {
    expect(isEmptyTabsEntry(normalizeTabsEntry([{ id: "t1", name: "n", fieldIds: [] }])!)).toBe(false);
  });

  /**
   * 语义归语义，**能不能真清空**取决于后端。`POST /api/views/:viewId/detail-layout`
   * 目前写不进空数组：请求到了、返回 200，但路由只在 `tabs.length > 0` 时才收这个键，
   * 净化阶段又把空数组整条丢掉 —— 结果就是「UI 上干净了 + 提示已保存 + 刷新后旧分页原样回来」。
   * 这比不回退更糟（用户以为做完了），所以前端用 TABS_CLEAR_SUPPORTED 闸门先挡住。
   * 后端 A1 裁决通过、支持清空后：把常量翻 true，这条断言会先红，提醒同步放开回退分支。
   */
  it("0 页的还原结果就是空数组，但后端当前写不进空数组，A1 未裁决前不得拿来清空", () => {
    const real = normalizeTabsEntry({ cards: [], lazyTouched: [] })!; // 真实信封形态
    expect(restoreTabsConfig(real, [{ id: "tab1", name: "基本信息", fieldIds: ["a"] }])).toEqual([]);
    expect(TABS_CLEAR_SUPPORTED).toBe(false);
  });
});

describe("结构化往返：存进去什么，回退就还原什么", () => {
  it("带宽度与行边界的多页容器，经 build -> parseSnapshot -> restore 后逐字节一致", () => {
    const original = {
      f1: [
        {
          id: "t1",
          name: "基本信息",
          fieldIds: ["a", "b"],
          widths: { a: 25, b: 75 } as Record<string, 25 | 50 | 75 | 100>,
          rows: [{ items: [{ fieldId: "a", widthPct: 25 as const }] }, { items: [{ fieldId: "b", widthPct: 75 as const }] }],
        },
        { id: "t2", name: "补充", fieldIds: ["c"] },
      ],
    };
    // 走一遍真实链路：build -> 塞进信封 -> JSON -> parseSnapshot -> restoreTabsConfig
    const snapshot = parseSnapshot({ version: 1, layout: null, tabs: buildTabsSnapshot(original) })!;
    const entry = snapshot.tabs!.f1!;
    expect(entry.kind).toBe("config");
    // 骨架传空数组：结构化路径不该依赖当前骨架，应当原样还原
    expect(restoreTabsConfig(entry, [])).toEqual(original.f1);
  });
});
