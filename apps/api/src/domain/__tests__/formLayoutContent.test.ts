// apps/api/src/domain/__tests__/formLayoutContent.test.ts
// 快照【内容】的单测：tabs 结构快照的采集（rows/fieldIds 并集）与净化（只剔孤儿、不改结构）。
//
// 这里的四条"不得误杀"用例全部经过证伪验证：把修复（collectReferencedFieldIds 下钻结构
// 快照、tabMemberIds 取并集）临时回退后，它们会转红；恢复后转绿。别把它们当普通回归删掉。

import { describe, it, expect } from "vitest";
import {
  buildSnapshotEnvelope,
  maybeAutoSnapshotLayoutTx,
  sanitizeLayoutTx,
  saveTabsConfigTx,
} from "../formLayoutVersion.js";
import { DELETED, makeFake, VIEW, type FakeField } from "./_formLayoutFake.js";

const container = (tabsConfig: string | null, deletedAt: Date | null = null): FakeField => ({
  id: "c1", tableId: "tb1", name: "分组", type: "tabs", tabsConfig, deletedAt,
});

describe("tabs 结构快照的净化", () => {
  it("净化：结构快照里已删字段被剔除，行内剩下的字段保持原行与原宽度", async () => {
    const { client } = makeFake({
      fields: [
        { id: "f1", tableId: "tb1", name: "A", type: "text", deletedAt: null, tabsConfig: null },
        container(JSON.stringify([
          { id: "t1", name: "A", fieldIds: ["f1", "ghost"], widths: { f1: 25, ghost: 50 }, rows: [{ items: [{ fieldId: "f1", widthPct: 25 }, { fieldId: "ghost", widthPct: 50 }] }] },
        ])),
      ],
    });
    const env = buildSnapshotEnvelope(null, { c1: { cards: ["f1", "ghost"], lazyTouched: [], tabs: [{ id: "t1", name: "A", fieldIds: ["f1", "ghost"], widths: { f1: 25, ghost: 50 }, rows: [{ items: [{ fieldId: "f1", widthPct: 25 }, { fieldId: "ghost", widthPct: 50 }] }] }] } });
    const res = await sanitizeLayoutTx(client, "tb1", env);
    const t = res.envelope.tabs["c1"]!.tabs![0]!;
    expect(t.fieldIds).toEqual(["f1"]);
    expect(t.widths).toEqual({ f1: 25 });
    expect(t.rows).toEqual([{ items: [{ fieldId: "f1", widthPct: 25 }] }]); // 行边界保住
    expect(res.removedFieldIds).toEqual(["ghost"]);
  });

  it("净化不得误杀：字段只在结构快照里、没进 cards，但库里活着 → 必须保留", async () => {
    // 这正是"探活集合没下钻结构快照"那个缺陷的可达路径：
    // cards 只有 f1，而 tabs[].fieldIds 有 f1+f2，f2 在库里未删。
    const { client } = makeFake({
      fields: [
        { id: "f1", tableId: "tb1", name: "A", type: "text", deletedAt: null, tabsConfig: null },
        { id: "f2", tableId: "tb1", name: "B", type: "text", deletedAt: null, tabsConfig: null },
        container("[{\"id\":\"t1\",\"name\":\"A\",\"fieldIds\":[\"f1\"]}]"),
      ],
    });
    const env = buildSnapshotEnvelope(null, {
      c1: { cards: ["f1"], lazyTouched: [], tabs: [{ id: "t1", name: "A", fieldIds: ["f1", "f2"] }] },
    });
    const res = await sanitizeLayoutTx(client, "tb1", env);
    expect(res.envelope.tabs["c1"]!.tabs![0]!.fieldIds).toEqual(["f1", "f2"]);
    expect(res.removedFieldIds).toEqual([]);
  });

  it("净化不得误杀：成员关系只存在于 rows（fieldIds 为空/过期）时 tab 不被清空", async () => {
    const { client } = makeFake({
      fields: [
        { id: "f1", tableId: "tb1", name: "A", type: "text", deletedAt: null, tabsConfig: null },
        { id: "f2", tableId: "tb1", name: "B", type: "text", deletedAt: null, tabsConfig: null },
        container("[{\"id\":\"t1\",\"name\":\"A\",\"fieldIds\":[\"f1\"]}]"),
      ],
    });
    const env = buildSnapshotEnvelope(null, {
      c1: {
        cards: ["f1"],
        lazyTouched: [],
        tabs: [{ id: "t1", name: "A", fieldIds: [], rows: [{ items: [{ fieldId: "f1", widthPct: 50 }, { fieldId: "f2", widthPct: 50 }] }] }],
      },
    });
    const res = await sanitizeLayoutTx(client, "tb1", env);
    expect(res.envelope.tabs["c1"]!.tabs![0]!.fieldIds).toEqual(["f1", "f2"]);
    expect(res.removedFieldIds).toEqual([]);
  });
});

describe("tabs 快照的采集", () => {
  it("cards 必须包含结构快照里的全部 id（双写漂移也不漏）", async () => {
    // rows 比 fieldIds 少一个 —— 历史上双写没同步好的典型形态
    const { client, versions } = makeFake({
      views: [VIEW],
      fields: [
        { id: "c1", tableId: "tb1", name: "分组", type: "tabs", deletedAt: null, tabsConfig: JSON.stringify([{ id: "t1", name: "A", fieldIds: ["f1", "f2"], rows: [{ items: [{ fieldId: "f1", widthPct: 50 }] }] }]) },
      ],
    });
    await maybeAutoSnapshotLayoutTx(client, "vw1", "u1", { now: 1_000_000 });
    const entry = JSON.parse(versions[0]!.snapshot).tabs["c1"];
    expect(entry.cards).toEqual(["f1", "f2"]); // 并集，不是 rows 单边的 ["f1"]
  });
});

describe("saveTabsConfigTx", () => {
  it("键解析不到 tabs 字段（非 tabs / 已软删）→ 进 skipped，不静默吞掉", async () => {
    const { client } = makeFake({
      fields: [
        { id: "c1", tableId: "tb1", name: "分组", type: "tabs", deletedAt: null, tabsConfig: "[]" },
        { id: "c2", tableId: "tb1", name: "非tabs", type: "text", deletedAt: null, tabsConfig: null },
        { id: "c3", tableId: "tb1", name: "已删分组", type: "tabs", deletedAt: DELETED, tabsConfig: "[]" },
      ],
    });
    const res = await saveTabsConfigTx(client, "tb1", {
      c1: [{ id: "t1", name: "A", fieldIds: ["f1"] }],
      c2: [{ id: "t2", name: "B", fieldIds: ["f2"] }],
      c3: [{ id: "t3", name: "C", fieldIds: ["f3"] }],
    });
    expect(res.updated).toEqual(["c1"]);
    expect(res.skipped).toEqual(["c2", "c3"]); // 前端靠这个提示"有 N 个容器没写进去"
  });

  it("只碰 tabsConfig 一列，并把 name 原值一起写回", async () => {
    const { client, log } = makeFake({
      fields: [{ id: "c1", tableId: "tb1", name: "分组", type: "tabs", deletedAt: null, tabsConfig: "[]" }],
    });
    await saveTabsConfigTx(client, "tb1", { c1: [{ id: "t1", name: "A", fieldIds: ["f1"] }] });
    expect(log).toEqual(["field.update:c1:name,tabsConfig"]);
  });
});

describe("sanitizeLayoutTx", () => {
  it("剔除孤儿字段与孤儿 tab slot，但不重排、不扁平化", async () => {
    const { client } = makeFake({
      fields: [
        { id: "f1", tableId: "tb1", name: "A", type: "text", deletedAt: null, tabsConfig: null },
        { id: "f3", tableId: "tb1", name: "C", type: "text", deletedAt: null, tabsConfig: null },
        { id: "c1", tableId: "tb1", name: "分组", type: "tabs", deletedAt: null, tabsConfig: JSON.stringify([{ id: "t1", name: "基本信息", fieldIds: ["f1"] }]) },
      ],
    });
    const env = buildSnapshotEnvelope(
      {
        defaultRowColumns: 2,
        rows: [
          { colCount: 2, fieldIds: ["f1", "ghost", "f3"], widths: { f1: 50, ghost: 25, f3: 50 } },
          { colCount: 1, fieldIds: ["ghost2"] },
        ],
      },
      {
        c1: { cards: ["f1", "ghost"], lazyTouched: ["t1", "t_gone"] },
        c_gone: { cards: ["f3"], lazyTouched: [] },
      },
    );
    const res = await sanitizeLayoutTx(client, "tb1", env);
    expect(res.envelope.layout!.rows).toHaveLength(1); // 全孤儿的行整行移除
    expect(res.envelope.layout!.rows[0]!.fieldIds).toEqual(["f1", "f3"]); // 顺序不变
    expect(res.envelope.layout!.rows[0]!.colCount).toBe(2); // 列数不动
    expect(res.envelope.layout!.rows[0]!.widths).toEqual({ f1: 50, f3: 50 });
    expect(Object.keys(res.envelope.tabs)).toEqual(["c1"]);
    expect(res.envelope.tabs["c1"]!.cards).toEqual(["f1"]);
    expect(res.envelope.tabs["c1"]!.lazyTouched).toEqual(["t1"]);
    expect(res.removedFieldIds.sort()).toEqual(["ghost", "ghost2"]);
    expect(res.removedTabKeys).toEqual(["c_gone"]);
  });
});
