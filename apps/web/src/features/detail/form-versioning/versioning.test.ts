// apps/web/src/features/detail/form-versioning/versioning.test.ts
// versioning.ts（信封解析 / 排序 / 时间 / 禁用判定）的单测。不依赖 React / DOM / 网络。
// tabs 段的归一与还原见 ./tabs-snapshot.test.ts。

import { describe, expect, it } from "vitest";
import type { DetailLayout } from "@gx/shared-types";
import {
  AUTO_BACKUP_LABEL,
  dropUnknownFieldIds,
  formatVersionTime,
  formatVersionTimeAgo,
  historyBlockReason,
  nextVersion,
  parseSnapshot,
  rollbackBlockReason,
  snapshotIsEmpty,
  snapshotStats,
  sortVersionsDesc,
  versionTitle,
  type LayoutVersionSummary,
} from "./versioning";
import { isEmptyTabsEntry } from "./tabs-snapshot";

const layout = (rows: { fieldIds: string[]; widths?: Record<string, number> }[]): DetailLayout => ({
  defaultRowColumns: 2,
  rows: rows.map((r) => ({ colCount: 2, ...r })) as DetailLayout["rows"],
});

const ver = (version: number, id = `v${version}`, createdAt = `2026-09-2${version}T00:00:00.000Z`): LayoutVersionSummary => ({
  id,
  viewId: "view1",
  version,
  label: null,
  createdBy: "",
  createdAt,
});

describe("parseSnapshot", () => {
  it("JSON 字符串信封能解出 layout 与 tabs", () => {
    const raw = JSON.stringify({ version: 3, layout: layout([{ fieldIds: ["a", "b"] }]), tabs: { t1: { cards: ["c"], lazyTouched: ["c"] } } });
    const s = parseSnapshot(raw);
    expect(s).not.toBeNull();
    expect(s!.version).toBe(3);
    expect(s!.layout?.rows[0]?.fieldIds).toEqual(["a", "b"]);
    expect(s!.tabs?.t1?.kind).toBe("bucket");
  });

  it("直接给对象也能解（后端若改成对象形态不用改前端）", () => {
    expect(parseSnapshot({ version: 1, layout: layout([{ fieldIds: ["a"] }]) })?.version).toBe(1);
  });

  it("坏 JSON / 非对象一律返回 null，不抛", () => {
    expect(parseSnapshot("{oops")).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot(42)).toBeNull();
    expect(parseSnapshot([])).toBeNull();
  });

  it("layout 缺 rows 时降级为 null（不把半个布局当可用）", () => {
    expect(parseSnapshot({ version: 1, layout: { defaultRowColumns: 2 } })?.layout).toBeNull();
  });

  it("某个 tabs 容器形状认不出来时跳过它，其余容器仍可用", () => {
    const s = parseSnapshot({ version: 1, layout: null, tabs: { good: { cards: ["x"] }, weird: 7 } });
    expect(s?.tabs?.good?.kind).toBe("bucket");
    expect(s?.tabs?.weird).toBeUndefined();
  });

  it("tabs 缺失时是 null 而不是 undefined（调用方只判一次）", () => {
    expect(parseSnapshot({ version: 1, layout: null })?.tabs).toBeNull();
  });
});

describe("sortVersionsDesc / nextVersion", () => {
  it("按 version 倒序，不改原数组", () => {
    const src = [ver(1), ver(3), ver(2)];
    const out = sortVersionsDesc(src);
    expect(out.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(src.map((v) => v.version)).toEqual([1, 3, 2]);
  });

  it("同版本号按 createdAt 倒序（后建的在前）", () => {
    const out = sortVersionsDesc([
      { ...ver(2, "a"), createdAt: "2026-09-01T00:00:00.000Z" },
      { ...ver(2, "b"), createdAt: "2026-09-09T00:00:00.000Z" },
    ]);
    expect(out.map((v) => v.id)).toEqual(["b", "a"]);
  });

  it("nextVersion：空列表为 1，有版本为 max+1，非法 version 当 0", () => {
    expect(nextVersion([])).toBe(1);
    expect(nextVersion([ver(1), ver(4), ver(2)])).toBe(5);
    expect(nextVersion([{ ...ver(1), version: Number.NaN }])).toBe(1);
  });
});

describe("formatVersionTime", () => {
  it("本地时间串按原样格式化（不带时区后缀，跨时区结果稳定）", () => {
    expect(formatVersionTime("2026-09-22T13:05:00")).toBe("2026-09-22 13:05");
  });

  it("空 / 非法输入返回空串，不抛也不输出 Invalid Date", () => {
    expect(formatVersionTime(null)).toBe("");
    expect(formatVersionTime("不是时间")).toBe("");
  });
});

describe("formatVersionTimeAgo", () => {
  const now = new Date("2026-09-22T12:00:00Z").getTime();

  it("分档：刚刚 / 分钟 / 小时 / 天", () => {
    expect(formatVersionTimeAgo("2026-09-22T11:59:30Z", now)).toBe("刚刚");
    expect(formatVersionTimeAgo("2026-09-22T11:41:00Z", now)).toBe("19 分钟前");
    expect(formatVersionTimeAgo("2026-09-22T07:00:00Z", now)).toBe("5 小时前");
    expect(formatVersionTimeAgo("2026-09-19T12:00:00Z", now)).toBe("3 天前");
  });

  it("超过 7 天回落绝对时间（now 注入，结果确定）", () => {
    expect(formatVersionTimeAgo("2026-08-01T12:00:00Z", now)).toBe(formatVersionTime("2026-08-01T12:00:00Z"));
  });

  it("未来时间不编造「-3 分钟前」，直接给绝对时间", () => {
    expect(formatVersionTimeAgo("2026-09-23T12:00:00Z", now)).toBe(formatVersionTime("2026-09-23T12:00:00Z"));
  });

  it("非法输入返回空串", () => {
    expect(formatVersionTimeAgo("x", now)).toBe("");
  });
});

describe("versionTitle / snapshotStats / snapshotIsEmpty", () => {
  it("无备注只显示版本号", () => {
    expect(versionTitle({ version: 3, label: null })).toBe("v3");
    expect(versionTitle({ version: 3, label: "上线前" })).toBe("v3 · 上线前");
    expect(versionTitle({ version: 3, label: "   " })).toBe("v3");
  });

  it("统计顶层与选项卡内字段数（顶层按 id 去重）", () => {
    const s = parseSnapshot({
      version: 1,
      layout: layout([{ fieldIds: ["a", "b"] }, { fieldIds: ["b", "c"] }]),
      tabs: { t1: { cards: ["d", "e"] }, t2: [{ id: "x", name: "n", fieldIds: ["f"] }] },
    })!;
    expect(snapshotStats(s)).toEqual({ rowCount: 2, fieldCount: 3, tabContainerCount: 2, tabFieldCount: 3 });
  });

  it("空快照判定：既没字段也没选项卡内容", () => {
    expect(snapshotIsEmpty(null)).toBe(true);
    expect(snapshotIsEmpty(parseSnapshot({ version: 1, layout: layout([]), tabs: {} })!)).toBe(true);
    expect(snapshotIsEmpty(parseSnapshot({ version: 1, layout: layout([{ fieldIds: ["a"] }]) })!)).toBe(false);
  });
});

describe("rollbackBlockReason / historyBlockReason", () => {
  const ok = { viewId: "view1", selectedId: "r1", snapshot: parseSnapshot({ version: 1, layout: layout([{ fieldIds: ["a"] }]) }), busy: false, readOnly: false };

  it("条件齐备时放行（null）", () => {
    expect(rollbackBlockReason(ok)).toBeNull();
  });

  it("逐条给出禁用原因：缺 viewId / 只读 / 未选版本 / 快照解析失败 / 忙碌", () => {
    expect(rollbackBlockReason({ ...ok, viewId: null })).toContain("视图");
    expect(rollbackBlockReason({ ...ok, readOnly: true })).toContain("权限");
    expect(rollbackBlockReason({ ...ok, selectedId: null })).toContain("选择");
    expect(rollbackBlockReason({ ...ok, snapshot: null })).toContain("快照");
    expect(rollbackBlockReason({ ...ok, busy: true })).toContain("处理中");
  });

  it("历史入口只看 viewId", () => {
    expect(historyBlockReason("v1")).toBeNull();
    expect(historyBlockReason(null)).toContain("视图");
  });
});

describe("dropUnknownFieldIds", () => {
  it("删掉的字段不能凭快照复活，且同步清掉它的宽度", () => {
    const out = dropUnknownFieldIds(layout([{ fieldIds: ["a", "gone"], widths: { a: 50, gone: 50 } }]), ["a"])!;
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.fieldIds).toEqual(["a"]);
    expect(out.rows[0]!.widths).toEqual({ a: 50 });
  });

  it("整行字段都被删掉时该行消失", () => {
    expect(dropUnknownFieldIds(layout([{ fieldIds: ["gone"] }, { fieldIds: ["a"] }]), ["a"])?.rows).toHaveLength(1);
  });

  it("null 进出为 null", () => {
    expect(dropUnknownFieldIds(null, ["a"])).toBeNull();
  });
});

describe("AUTO_BACKUP_LABEL", () => {
  it("回退前自动备份的备注是产品拍板的固定文案", () => {
    expect(AUTO_BACKUP_LABEL).toBe("回退前自动备份");
  });
});

// 后端信封里的 tabs 容器值是**带 cards 的对象** `{ cards, lazyTouched, tabs?: TabConfig[] }`。
// parseSnapshot 必须整条交给 normalizeTabsEntry 归一；一旦绕过它自己读 `raw.cards`，
// 结构快照就会被吃掉降级成 bucket —— 回退时按当前骨架重建，宽度 / 行边界全丢（假回退）。
describe("parseSnapshot：tabs 段必须走 normalizeTabsEntry", () => {
  const objectWire = {
    cards: ["a"],
    lazyTouched: [],
    tabs: [
      {
        id: "t1",
        name: "基本信息",
        fieldIds: ["a"],
        widths: { a: 75 },
        rows: [{ items: [{ fieldId: "a", widthPct: 75 }] }],
      },
    ],
  };

  it("对象形态 + tabs 结构 -> config，宽度与行边界都随信封回来", () => {
    const snap = parseSnapshot({ version: 1, layout: null, tabs: { f1: objectWire } })!;
    const entry = snap.tabs!.f1!;
    expect(entry.kind).toBe("config");
    if (entry.kind !== "config") throw new Error("unreachable");
    expect(entry.tabs[0]!.widths).toEqual({ a: 75 });
    expect(entry.tabs[0]!.rows).toEqual([{ items: [{ fieldId: "a", widthPct: 75 }] }]);
  });

  it("后端给的是 JSON 字符串（真实链路），同样按对象形态解析", () => {
    const snap = parseSnapshot(JSON.stringify({ version: 1, layout: null, tabs: { f1: objectWire } }))!;
    expect(snap.tabs!.f1!.kind).toBe("config");
  });

  it("老扁平形态仍读成 bucket（向后兼容没被这次改造弄丢）", () => {
    const snap = parseSnapshot({ version: 1, layout: null, tabs: { f1: { cards: ["a"], lazyTouched: [] } } })!;
    expect(snap.tabs!.f1!.kind).toBe("bucket");
  });

  it("空的扁平快照判为「0 页」：回退时是否真清空由 TABS_CLEAR_SUPPORTED 闸门决定", () => {
    const snap = parseSnapshot({ version: 1, layout: null, tabs: { f1: { cards: [], lazyTouched: [] } } })!;
    expect(isEmptyTabsEntry(snap.tabs!.f1!)).toBe(true);
  });
});
