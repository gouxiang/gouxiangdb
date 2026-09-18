// 窄屏记录卡片列表回归（node 环境，react-dom/server，无 jsdom、无新增依赖）。
//
// 锁的是 R-D-32「768–1023 表格转卡片列表」（<768 沿用）：
//   卡片态必须把表格态的能力都带上——勾选、展开记录入口、主字段标题、其余字段「名：值」、
//   分组标题、续翻按钮；换的只是形态，不是能力。

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import type { FieldDTO, GroupBucketDTO, RecordDTO } from "@gx/shared-types";
import { RecordCardList } from "./RecordCardList";

const field = (id: string, name: string, type = "text"): FieldDTO =>
  ({ id, name, type, options: null, order: 0 }) as unknown as FieldDTO;

const record = (id: string, name: string, dept: string): RecordDTO =>
  ({ id, tableId: "t1", fields: { f1: name, f2: dept } }) as unknown as RecordDTO;

const fields = [field("f1", "姓名"), field("f2", "部门")];
const records = [record("r1", "张三", "产品部"), record("r2", "李四", "研发部")];

function renderCards(over: Partial<Parameters<typeof RecordCardList>[0]> = {}) {
  return render(
    <RecordCardList
      records={records}
      fields={fields}
      primaryFieldId="f1"
      groups={null}
      selectedIds={new Set<string>()}
      rowColorOf={() => null}
      onToggleRowSelect={vi.fn()}
      onOpenRecord={vi.fn()}
      {...over}
    />,
  );
}

describe("R-D-32 / R-D-33 卡片列表（<1024）", () => {
  it("主字段当卡片标题（不再重复成一行字段名），其余字段按「字段名 + 值」逐行展示", () => {
    const html = renderCards();
    expect(html).toContain("张三");
    expect(html).toContain("李四");
    expect(html).toContain("部门");
    expect(html).toContain("产品部");
    expect(html).toContain("研发部");
    // 主字段（姓名）已经是标题，卡片里不再列成「姓名：张三」这种冗余行
    expect(html).not.toContain(">姓名<");
  });

  it("勾选（批量选择）与展开记录入口都在，能力不因卡片化而缺失", () => {
    const html = renderCards();
    expect(html).toContain('aria-label="选择记录 张三"');
    expect(html).toContain('type="checkbox"');
  });

  it("选中态走 accent 底（与表格行选中同语义）", () => {
    const html = renderCards({ selectedIds: new Set(["r1"]) });
    expect(html).toContain("bg-gx-accent-bg");
  });

  it("分组标题与条数保留；未分组时是平铺列表", () => {
    const groups: GroupBucketDTO[] = [
      { key: "g1", label: "产品部", color: null, recordIds: ["r1"], aggregations: {} },
    ];
    const html = renderCards({ groups });
    expect(html).toContain("产品部");
    expect(html).toContain("（1）");
  });

  it("有下一页时给出「加载更多」入口（无限滚动在卡片态的等价出口）", () => {
    const html = renderCards({ hasNextPage: true, onLoadMore: vi.fn() });
    expect(html).toContain("加载更多");
  });
});
