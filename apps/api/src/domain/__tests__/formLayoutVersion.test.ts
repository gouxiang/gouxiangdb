// apps/api/src/domain/__tests__/formLayoutVersion.test.ts
// 布局版本的策略层单测：淘汰集合提取、裁剪、自动快照时间窗与版本号。
// 事务 client 用内存假实现（_formLayoutFake.ts），不碰真实 dev.db。

import { describe, it, expect } from "vitest";
import type { TabConfig } from "@gx/shared-types";
import {
  AUTO_INTERVAL_MS,
  AUTO_MAX_VERSIONS,
  buildVersionExtractor,
  maybeAutoSnapshotLayoutTx,
  pruneAutoVersionsTx,
  SNAPSHOT_ENVELOPE_VERSION,
} from "../formLayoutVersion.js";
import { DELETED, makeFake, VIEW, type Row } from "./_formLayoutFake.js";

const at = (ms: number) => new Date(ms);

describe("buildVersionExtractor", () => {
  const rows = (n: number, label: string | null = null, start = 1) =>
    Array.from({ length: n }, (_, i) => ({ id: `v${start + i}`, version: start + i, label }));

  it("自动版本未超上限 → 不删任何一条", () => {
    const { keep, drop } = buildVersionExtractor(rows(AUTO_MAX_VERSIONS));
    expect(drop).toEqual([]);
    expect(keep).toHaveLength(AUTO_MAX_VERSIONS);
  });

  it("超上限 → 从最旧的自动版本开始删，保留最新 N 条", () => {
    const { keep, drop } = buildVersionExtractor(rows(AUTO_MAX_VERSIONS + 3));
    expect(drop).toEqual(["v1", "v2", "v3"]);
    expect(keep).toHaveLength(AUTO_MAX_VERSIONS);
    expect(keep).not.toContain("v1");
  });

  it("手动版本永不淘汰，哪怕它是最旧的一条", () => {
    const all = [{ id: "m1", version: 1, label: "回退前自动备份" }, ...rows(AUTO_MAX_VERSIONS + 1, null, 2)];
    const { keep, drop } = buildVersionExtractor(all);
    expect(drop).toEqual(["v2"]);
    expect(keep).toContain("m1");
  });

  it("顺序敏感：乱序入参也按 version 升序淘汰最旧", () => {
    const shuffled = [
      { id: "v5", version: 5, label: null },
      { id: "v1", version: 1, label: null },
      { id: "v3", version: 3, label: null },
    ];
    const { drop } = buildVersionExtractor(shuffled, 2);
    expect(drop).toEqual(["v1"]);
  });
});

describe("pruneAutoVersionsTx", () => {
  it("只删最旧的自动版本，手动版本原样保留", async () => {
    const versions: Row[] = [
      { id: "m1", viewId: "vw1", version: 1, label: "回退前自动备份", snapshot: "{}", createdBy: "u1", createdAt: new Date(1000) },
      ...Array.from({ length: 55 }, (_, i) => ({
        id: `a${i}`,
        viewId: "vw1",
        version: i + 2,
        label: null,
        snapshot: "{}",
        createdBy: "u1",
        createdAt: new Date(2000 + i),
      })),
    ];
    const { client, versions: live } = makeFake({ versions });
    const n = await pruneAutoVersionsTx(client, "vw1");
    expect(n).toBe(5); // 55 - 50
    expect(live.find((v) => v.id === "a0")).toBeUndefined();
    expect(live.find((v) => v.id === "a4")).toBeUndefined();
    expect(live.find((v) => v.id === "a5")).toBeDefined();
    expect(live.find((v) => v.id === "m1")).toBeDefined();
  });

  it("未超上限时零删除", async () => {
    const { client } = makeFake({
      versions: Array.from({ length: 10 }, (_, i) => ({
        id: `a${i}`, viewId: "vw1", version: i + 1, label: null, snapshot: "{}", createdBy: "u1", createdAt: new Date(i),
      })),
    });
    expect(await pruneAutoVersionsTx(client, "vw1")).toBe(0);
  });
});

describe("maybeAutoSnapshotLayoutTx", () => {
  it("无历史 → 立即留一版，版本号 1", async () => {
    const { client, versions } = makeFake({ views: [VIEW] });
    const r = await maybeAutoSnapshotLayoutTx(client, "vw1", "u1", { now: 1_000_000, viewConfigJson: JSON.stringify({ detailLayout: { defaultRowColumns: 2, rows: [] } }) });
    expect(r).toEqual({ created: true, version: 1 });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.label).toBeNull();
    expect(JSON.parse(versions[0]!.snapshot).version).toBe(SNAPSHOT_ENVELOPE_VERSION);
  });

  it("距上一版不足 10 分钟 → 不留版", async () => {
    const { client, versions } = makeFake({
      views: [VIEW],
      versions: [{ id: "v1", viewId: "vw1", version: 1, label: null, snapshot: "{}", createdBy: "u1", createdAt: at(1_000_000) }],
    });
    const r = await maybeAutoSnapshotLayoutTx(client, "vw1", "u1", { now: 1_000_000 + AUTO_INTERVAL_MS - 1 });
    expect(r.created).toBe(false);
    expect(versions).toHaveLength(1);
  });

  it("超过 10 分钟窗口 → 留新版，版本号 = max+1", async () => {
    const { client, versions } = makeFake({
      views: [VIEW],
      versions: [
        { id: "v1", viewId: "vw1", version: 1, label: null, snapshot: "{}", createdBy: "u1", createdAt: at(1_000_000) },
        { id: "m2", viewId: "vw1", version: 2, label: "回退前自动备份", snapshot: "{}", createdBy: "u1", createdAt: at(1_100_000) },
      ],
    });
    // 窗口以【最新版本】（此处是 v2 那条手动档）的 createdAt 起算
    const r = await maybeAutoSnapshotLayoutTx(client, "vw1", "u1", { now: 1_100_000 + AUTO_INTERVAL_MS + 1 });
    expect(r).toEqual({ created: true, version: 3 });
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2, 3]);
  });

  it("force 跳过时间窗；grid 视图无 detailLayout → 不留版", async () => {
    const a = makeFake({
      views: [VIEW],
      versions: [{ id: "v1", viewId: "vw1", version: 1, label: null, snapshot: "{}", createdBy: "u1", createdAt: at(1_000_000) }],
    });
    expect((await maybeAutoSnapshotLayoutTx(a.client, "vw1", "u1", { now: 1_000_001, force: true })).created).toBe(true);

    const b = makeFake({ views: [{ ...VIEW, type: "grid" }] });
    expect(await maybeAutoSnapshotLayoutTx(b.client, "vw1", "u1", { now: 1_000_000 })).toEqual({
      created: false, version: null, reason: "no-detail-layout",
    });
    expect(b.versions).toHaveLength(0);
  });

  it("grid 视图存过 detailLayout → 留版（默认路径下的版本/回退不能静默失效）", async () => {
    // 证伪过的回归：把 formLayoutVersion.ts 的判据改回 `viewType !== "detail"` 本条立刻转红。
    // 记录抽屉读的是【当前视图】的 config.detailLayout，绝大多数表没有 detail 视图，
    // 表单设计器 fallback 到 views[0]（通常是 grid）后保存的布局照样是生效的。
    const gridWithLayout = { ...VIEW, type: "grid", config: JSON.stringify({ detailLayout: { defaultRowColumns: 2, rows: [] } }) };
    const { client, versions } = makeFake({ views: [gridWithLayout] });
    const r = await maybeAutoSnapshotLayoutTx(client, "vw1", "u1", { now: 1_000_000 });
    expect(r).toEqual({ created: true, version: 1 });
    expect(versions).toHaveLength(1);
    expect(versions[0]!.viewId).toBe("vw1");
    const env = JSON.parse(versions[0]!.snapshot);
    expect(env.version).toBe(SNAPSHOT_ENVELOPE_VERSION);
    expect(env.layout).not.toBeNull(); // 布局正文真进信封，回退才还原得出东西
  });

  it("grid 视图只有筛选/排序（无 detailLayout）→ 不留版，不堆垃圾版本", async () => {
    const gridFilterOnly = { ...VIEW, type: "grid", config: JSON.stringify({ filter: {}, sorts: [] }) };
    const { client, versions } = makeFake({ views: [gridFilterOnly] });
    const r = await maybeAutoSnapshotLayoutTx(client, "vw1", "u1", { now: 1_000_000, force: true });
    expect(r).toEqual({ created: false, version: null, reason: "no-detail-layout" });
    expect(versions).toHaveLength(0);
  });

  it("grid 视图 config 里 detailLayout 是 null → 同样不留版（parseViewConfig 的默认值就是 null）", async () => {
    // views.ts 的 PATCH 用 parseViewConfig 的全量默认值 merge（恒带 detailLayout: null），
    // 所以判据必须是 nullish：只判 undefined 的话，grid 改一次筛选就落一版空布局脏档。
    const { client, versions } = makeFake({ views: [{ ...VIEW, type: "grid", config: '{"detailLayout":null}' }] });
    const r = await maybeAutoSnapshotLayoutTx(client, "vw1", "u1", { now: 1_000_000, force: true });
    expect(r).toEqual({ created: false, version: null, reason: "no-detail-layout" });
    expect(versions).toHaveLength(0);
  });

  it("detail 视图行为不变：没存过 detailLayout 也照旧留档", async () => {
    const { client, versions } = makeFake({ views: [VIEW] }); // VIEW.type=detail、config="{}"
    const r = await maybeAutoSnapshotLayoutTx(client, "vw1", "u1", { now: 1_000_000, viewConfigJson: "{}" });
    expect(r).toEqual({ created: true, version: 1 });
    expect(versions).toHaveLength(1);
    expect(JSON.parse(versions[0]!.snapshot).layout).toBeNull(); // 布局为空也留档：记录的是"清空"这个事实
  });

  it("视图不存在 → created=false，不抛错（快照是旁路，不阻断保存）", async () => {
    const { client, versions } = makeFake({});
    expect((await maybeAutoSnapshotLayoutTx(client, "nope", "u1", { now: 1 })).created).toBe(false);
    expect(versions).toHaveLength(0);
  });

  it("落版本后自动裁剪：连续写入不会突破 AUTO_MAX_VERSIONS", async () => {
    const { client, versions } = makeFake({ views: [VIEW] });
    for (let i = 0; i < AUTO_MAX_VERSIONS + 12; i++) {
      await maybeAutoSnapshotLayoutTx(client, "vw1", "u1", { now: 1_000_000 + i * AUTO_INTERVAL_MS * 2, force: true });
    }
    expect(versions).toHaveLength(AUTO_MAX_VERSIONS);
    const vs = versions.map((v) => v.version).sort((x, y) => x - y);
    expect(vs[0]).toBe(13); // 最旧的 12 条已被淘汰
    expect(vs[vs.length - 1]).toBe(AUTO_MAX_VERSIONS + 12);
  });

  it("快照里带上服务端自采的 tabs（来自未软删的 tabs 字段）", async () => {
    const { client, versions } = makeFake({
      views: [VIEW],
      fields: [
        { id: "c1", tableId: "tb1", name: "分组", type: "tabs", deletedAt: null, tabsConfig: JSON.stringify([{ id: "t1", name: "基本信息", fieldIds: ["f1", "f2"] }]) },
        { id: "c2", tableId: "tb1", name: "已删分组", type: "tabs", deletedAt: DELETED, tabsConfig: JSON.stringify([{ id: "t9", name: "x", fieldIds: ["f3"] }]) },
      ],
    });
    await maybeAutoSnapshotLayoutTx(client, "vw1", "u1", { now: 1_000_000 });
    const env = JSON.parse(versions[0]!.snapshot);
    expect(Object.keys(env.tabs)).toEqual(["c1"]);
    expect(env.tabs["c1"].cards).toEqual(["f1", "f2"]);
  });

  it("多 tab 容器：结构快照保住分组/宽度/行边界（只靠 cards 是还原不出来的）", async () => {
    const tabCfg: TabConfig[] = [
      { id: "t1", name: "A", fieldIds: ["f1"], widths: { f1: 25 }, rows: [{ items: [{ fieldId: "f1", widthPct: 25 }] }] },
      { id: "t2", name: "B", fieldIds: ["f2", "f3"], widths: { f2: 75, f3: 50 } },
    ];
    const { client, versions } = makeFake({
      views: [VIEW],
      fields: [{ id: "c1", tableId: "tb1", name: "分组", type: "tabs", deletedAt: null, tabsConfig: JSON.stringify(tabCfg) }],
    });
    await maybeAutoSnapshotLayoutTx(client, "vw1", "u1", { now: 1_000_000 });
    const entry = JSON.parse(versions[0]!.snapshot).tabs["c1"];
    expect(entry.cards).toEqual(["f1", "f2", "f3"]); // 展平成员：只回答"在不在容器里"
    expect(entry.tabs).toEqual(tabCfg); // 结构快照：分组、宽度、行边界全在
  });
});
