// apps/web/src/features/detail/form-designer-hydrate.test.ts
// ?design=1 进入表单设计器 →「已保存选项卡不渲染 → 再保存覆盖服务端 tabsConfig」P0 回归
//
// 现场（预览机抓取，已造成真实数据丢失）：
//   保存前 tabsConfig = [{"id":"tab_a","name":"页A","fieldIds":["cmuct7tzx0064pgsqpwql3ufb"]}]
//   保存后 tabsConfig = [{"id":"tab_cmuct8v0o…","name":"选项卡 1","fieldIds":[],"widths":{}}]
//
// 根因：FormDesigner 的 rows / tabsConfigMap / activeTabMap 三个 state 都是 useState 惰性
//   初始化，只在首屏跑一次。侧栏「编辑表单」/ 直输 ?design=1 进来时首屏 fields 还是空数组
//   —— DetailView.tsx:111 `if (editingLayout)` 的早退排在 `isLoading` 判空（:135）之前，
//   而 design=1 的 effect（:60）在挂载那一刻就把 editingLayout 置 true，于是设计器先于
//   字段挂载，initialTabsConfig([]) = {}，之后 state 永不重灌：画布显示「该选项卡下还没有
//   字段」，此时点「添加选项卡」+「保存布局」就会把服务端真值覆盖成空。
//   对照组（详情视图齿轮进入，fields 已就绪）能渲染页A —— 正是初始化时机问题。
// 修法：只在「首屏确实没数据、后来数据到了」时补灌一次，其余情况一律不动。
//
// 为什么不是真渲染（先说清，不藏着）：
//   本仓 web 侧单测跑在 **node 环境**（vite.config.ts 的 test 段未设 environment，依赖树里
//   没有 jsdom / happy-dom / @testing-library/react，与 save-layout.test.tsx、
//   drop-target.test.tsx 同源的「无 jsdom、无新增依赖」约定）。而 open 态的 FormDesigner
//   走 createPortal（FormDesigner.tsx:1289），react-dom/server 直接抛错；node 下也没有任何
//   能跑 useEffect 的渲染器。故按约定退一档：effect 的**判据**（shouldHydrateOnce）与
//   **载荷**（initialTabsConfig / initialRows）都是真实生产函数，逐条真跑；effect 本体的
//   三个 setState 与「只补一次」用源码断言钉住 —— 删掉判据即转红（见文末证伪记录）。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { DetailLayout, DetailRowColumns, FieldDTO, FieldIdT, FieldType, TableIdT } from "@gx/shared-types";
import { initialTabsConfig, shouldHydrateOnce } from "./FormDesigner";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/** 造字段：只填测试关心的两项，其余按空值补齐（维持 FieldDTO 全类型，不用 as 强转） */
function field(id: string, type: FieldType, over: Partial<FieldDTO> = {}): FieldDTO {
  return {
    id: id as FieldIdT,
    tableId: "tbl_seed" as TableIdT,
    name: id,
    type,
    description: "",
    order: 0,
    required: false,
    unique: false,
    options: null,
    precision: null,
    linkFieldId: null,
    relatedTableId: null,
    relationKind: null,
    isReverse: false,
    reverseFieldId: null,
    linkDisplayFieldId: null,
    lookupFieldId: null,
    rollupFunction: null,
    recordFilter: null,
    formula: null,
    tabsConfig: null,
    displayedFieldIds: null,
    visibleFieldIds: null,
    defaultConfig: null,
    numberRule: null,
    ...over,
  };
}

/** 线上真值：旧数据（fieldIds + 无 rows）形态的「页A」，页内挂一个文本字段 */
const TABS_FIELD = field("fld_tabs_seed", "tabs", {
  tabsConfig: [{ id: "tab_a", name: "页A", fieldIds: ["cmuct7tzx0064pgsqpwql3ufb"] }],
});
const TEXT_FIELD = field("cmuct7tzx0064pgsqpwql3ufb", "singleLineText");
const FIELDS = [TEXT_FIELD, TABS_FIELD];
const SAVED_LAYOUT: DetailLayout = { defaultRowColumns: 2 as DetailRowColumns, rows: [] };

describe("initialTabsConfig：已保存的选项卡可从字段真实恢复", () => {
  /** bug 现场：首屏 fields=[] 时惰性初始化拿到的就是它，容器渲染成「该选项卡下还没有字段」 */
  it("首屏 fields 为空 → 空配置（这就是丢失现场）", () => {
    expect(initialTabsConfig([])).toEqual({});
  });

  it("旧数据（fieldIds、无 rows）→ 「页A」与页内字段都还在，没被降级成「选项卡 1」", () => {
    const cfg = initialTabsConfig(FIELDS);
    const tabs = cfg[TABS_FIELD.id];
    expect(tabs).toHaveLength(1);
    expect(tabs?.[0]?.id).toBe("tab_a");
    expect(tabs?.[0]?.name).toBe("页A");
    expect(tabs?.[0]?.rows.flatMap((r) => r.items.map((i) => i.fieldId))).toEqual(["cmuct7tzx0064pgsqpwql3ufb"]);
  });
});

describe("shouldHydrateOnce：只补一次的闸门", () => {
  it("首屏 fields 为空 → 数据没到继续等；数据一到就补灌", () => {
    expect(shouldHydrateOnce(true, [], null)).toBe(false); // 还在等，不能拿空数据覆盖
    expect(shouldHydrateOnce(true, FIELDS, null)).toBe(true); // fields 到了
    expect(shouldHydrateOnce(true, [], SAVED_LAYOUT)).toBe(true); // 只有 layout 到了
  });

  /** 防回归：首屏有数据时 ref 初值=false，后续 fields 引用再变也不许重灌，否则覆盖用户编辑 */
  it("首屏 fields 已有数据 → 后续 fields 引用变化也不补灌（不覆盖用户编辑）", () => {
    expect(shouldHydrateOnce(false, FIELDS, SAVED_LAYOUT)).toBe(false);
    const grown = [...FIELDS, field("fld_new_seed", "number")];
    expect(shouldHydrateOnce(false, grown, SAVED_LAYOUT)).toBe(false);
    expect(shouldHydrateOnce(false, [], null)).toBe(false);
  });

  it("补过一次即停用（ref 置 false 后永不再触发）", () => {
    expect(shouldHydrateOnce(false, FIELDS, SAVED_LAYOUT)).toBe(false);
  });
});

describe("补灌载荷：与首屏有数据时同口径（不会把真值覆盖成空）", () => {
  it("补灌后容器配置含「页A」，激活页为 tab_a，且页内字段非空", () => {
    // 复刻 effect 内的取值（调用的仍是真实生产函数）
    const nextTabs = initialTabsConfig(FIELDS);
    const activeTabMap = Object.fromEntries(Object.entries(nextTabs).map(([k, cfg]) => [k, cfg[0]?.id ?? ""]));
    expect(Object.keys(nextTabs)).toEqual([TABS_FIELD.id]);
    expect(activeTabMap).toEqual({ [TABS_FIELD.id]: "tab_a" });
    // 事故载荷是 { name: "选项卡 1", fieldIds: [] } —— 补灌后绝不能是空页
    expect(nextTabs[TABS_FIELD.id]?.[0]?.rows[0]?.items).toHaveLength(1);
  });
});

describe("接线回归：effect 真把三个 state 重灌一遍，且只补一次", () => {
  const src = read("./FormDesigner.tsx");

  it("ref 初值按首屏 fields/layout 是否到位取（首屏有数据 → 整条补灌链路不启用）", () => {
    expect(src).toContain("useRef(fields.length === 0 || layout == null)");
  });

  /** 证伪锚点：把 ref 判断删掉（改成无条件重灌）这条立刻转红 */
  it("判据走真实纯函数 shouldHydrateOnce（删掉 ref 判断即转红）", () => {
    expect(src).toContain("if (!shouldHydrateOnce(needsHydrateRef.current, fields, layout)) return;");
  });

  it("补完立刻停用：只补一次", () => {
    expect(src).toContain("needsHydrateRef.current = false;");
  });

  it("三个 state 全部重灌（漏一个 = 选项卡仍不渲染 / 激活页错位）", () => {
    expect(src).toContain("setRows(initialRows(layout, fields));");
    expect(src).toContain("setTabsConfigMap(nextTabs);");
    expect(src).toContain("setActiveTabMap(");
  });

  it("effect 依赖 fields/layout —— 数据到位那一刻就会跑", () => {
    expect(src).toMatch(/\}, \[fields, layout\]\);/);
  });
});

// 证伪记录（改代码实测，非推断）：
//   ① 把 effect 首行改成 `if (false) {}`（等价于去掉 ref 判断、无条件重灌）→
//      「判据走真实纯函数 shouldHydrateOnce」转红（1 failed）。
//   ② 把 shouldHydrateOnce 的 `pending &&` 去掉 →「首屏 fields 已有数据 → 不补灌」转红。
//   两处改回后 5 passed / 0 failed。
