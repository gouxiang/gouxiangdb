// apps/web/src/features/views/__tests__/view-config-route.test.ts
// 视图配置分流纯函数单测（#561）：使用态补丁判定 + 使用态键抽取。

import { describe, it, expect } from "vitest";
import type { ViewConfig } from "@gx/shared-types";
import {
  USE_STATE_KEYS,
  isUseStatePatch,
  pickUseState,
} from "../view-config-route";

function makeConfig(overrides: Partial<ViewConfig> = {}): ViewConfig {
  return {
    hiddenFieldIds: [],
    fieldOrder: [],
    rowHeight: "medium",
    filters: null,
    sorts: [],
    search: "",
    groupByFieldId: null,
    collapsedGroupKeys: [],
    aggregations: {},
    rowColor: { mode: "none", conditions: [] },
    coverFieldId: null,
    cardFieldIds: [],
    kanbanFieldId: null,
    dateFieldId: null,
    formFields: [],
    formTitle: "",
    formDescription: "",
    detailFieldIds: [],
    detailLayout: null,
    ...overrides,
  } as ViewConfig;
}

describe("USE_STATE_KEYS", () => {
  it("恰好包含 7 个使用态键", () => {
    expect([...USE_STATE_KEYS]).toEqual([
      "filters",
      "sorts",
      "search",
      "rowHeight",
      "collapsedGroupKeys",
      "groupByFieldId",
      "aggregations",
    ]);
  });
});

describe("isUseStatePatch", () => {
  it("单个使用态键返回 true", () => {
    expect(isUseStatePatch({ search: "abc" })).toBe(true);
  });

  it("全部为使用态键（多键）返回 true", () => {
    expect(
      isUseStatePatch({ sorts: [], rowHeight: "tall", collapsedGroupKeys: ["g1"] }),
    ).toBe(true);
  });

  it("混入结构层键 detailLayout 返回 false", () => {
    expect(isUseStatePatch({ filters: null, detailLayout: null })).toBe(false);
  });

  it("含字段范围键 hiddenFieldIds 返回 false", () => {
    expect(isUseStatePatch({ hiddenFieldIds: ["f1"] })).toBe(false);
  });

  it("含行颜色键 rowColor 返回 false", () => {
    expect(isUseStatePatch({ rowColor: { mode: "none" } })).toBe(false);
  });

  it("空对象返回 false（无可写键，不应触发 prefs 通道）", () => {
    expect(isUseStatePatch({})).toBe(false);
  });

  it("未知键返回 false", () => {
    expect(isUseStatePatch({ nope: 1 })).toBe(false);
  });
});

describe("pickUseState", () => {
  it("抽取 7 个使用态键", () => {
    const cfg = makeConfig({
      filters: { kind: "and", children: [] },
      sorts: [{ fieldId: "f1", direction: "asc" }],
      search: "hello",
      rowHeight: "tall",
      collapsedGroupKeys: ["g1", "g2"],
      groupByFieldId: "f3",
      aggregations: { f9: "sum" },
    });
    expect(pickUseState(cfg)).toEqual({
      filters: { kind: "and", children: [] },
      sorts: [{ fieldId: "f1", direction: "asc" }],
      search: "hello",
      rowHeight: "tall",
      collapsedGroupKeys: ["g1", "g2"],
      groupByFieldId: "f3",
      aggregations: { f9: "sum" },
    });
  });

  it("不含 version 键", () => {
    expect("version" in pickUseState(makeConfig())).toBe(false);
  });

  it("不含任何结构层键（hiddenFieldIds/fieldOrder/coverFieldId/detailLayout…）", () => {
    const picked = pickUseState(
      makeConfig({
        hiddenFieldIds: ["x"],
        fieldOrder: ["y"],
        coverFieldId: "c1",
        cardFieldIds: ["c2"],
        detailLayout: null,
        rowColor: { mode: "none", conditions: [] },
      }),
    );
    expect(picked).not.toHaveProperty("hiddenFieldIds");
    expect(picked).not.toHaveProperty("fieldOrder");
    expect(picked).not.toHaveProperty("coverFieldId");
    expect(picked).not.toHaveProperty("cardFieldIds");
    expect(picked).not.toHaveProperty("detailLayout");
    expect(picked).not.toHaveProperty("rowColor");
  });
});
