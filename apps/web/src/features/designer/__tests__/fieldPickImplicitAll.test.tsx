// 详情可见性「隐式全选」回归（SSR renderToStaticMarkup，无 jsdom、无新增依赖）。
//
// 戴总反馈：detailFieldIds=[]（后端语义=全部字段）时不应显示「0 个字段」空态，
// 默认就列出全部字段供直接删减；点移除要提交「全量去掉该 id」的显式数组，
// 不能把空数组 filter 后继续提交（空仍=全部，移除会被静默吞掉）。

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FieldDTO } from "@gx/shared-types";
import FieldPickList from "../FieldPickList";
import { detailBaseIds, reorderFields } from "../viewAdminFields";

const fields: FieldDTO[] = (
  [
    ["fld_a", "字段A"],
    ["fld_b", "字段B"],
    ["fld_c", "字段C"],
    ["fld_d", "字段D"],
    ["fld_e", "字段E"],
  ] as const
).map(([id, name]) => ({ id, name, type: "singleLineText" }) as unknown as FieldDTO);

const allIds = fields.map((f) => f.id);

function render(ids: readonly string[], defaultAll?: readonly string[]) {
  return renderToStaticMarkup(
    createElement(FieldPickList, {
      fields,
      ids,
      canEdit: true,
      defaultAllIds: defaultAll,
      onAdd: () => {},
      onRemove: () => {},
      onMove: () => {},
    }),
  );
}

describe("隐式全选态（ids=[] + defaultAllIds）", () => {
  it("渲染全部字段、计数为总数、不出现空态", () => {
    const html = render([], allIds);
    for (const f of fields) expect(html).toContain(f.name);
    expect(html).toContain("5 个字段");
    expect(html).not.toContain("0 个字段");
  });

  it("添加字段按钮禁用且 title 提示已全部显示", () => {
    const html = render([], allIds);
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="已显示全部字段"');
  });

  it("不传 defaultAllIds 时 ids=[] 仍是空态，行为不变（数据展示口径）", () => {
    const html = render([]);
    expect(html).toContain("0 个字段");
    for (const f of fields) expect(html).not.toContain(f.name);
  });

  it("ids 非空后行为与显式数组一致（只渲染已选）", () => {
    const html = render(["fld_a", "fld_c"], allIds);
    expect(html).toContain("2 个字段");
    expect(html).toContain("字段A");
    expect(html).toContain("字段C");
    expect(html).not.toContain("字段B");
  });
});

describe("隐式全选态移除 → 显式数组（detailBaseIds）", () => {
  it("空显式数组回落到全量，filter 后得到具体显式数组", () => {
    // 模拟点「移除 字段C」：baseIds=全量，去掉该 id 后非空，即显式范围。
    const next = detailBaseIds([], allIds).filter((x) => x !== "fld_c");
    expect(next).toEqual(["fld_a", "fld_b", "fld_d", "fld_e"]);
  });

  it("显式数组非空时以它为准，不再回落全量", () => {
    expect(detailBaseIds(["fld_a"], allIds)).toEqual(["fld_a"]);
  });
});

describe("拖拽排序纯函数 reorderFields", () => {
  it("首项拖到末尾", () => {
    expect(reorderFields(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("末项拖到首位", () => {
    expect(reorderFields(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("中间项下移一位", () => {
    expect(reorderFields(["a", "b", "c", "d"], 1, 2)).toEqual(["a", "c", "b", "d"]);
  });

  it("from===to 或越界时顺序不变", () => {
    expect(reorderFields(["a", "b"], 0, 0)).toEqual(["a", "b"]);
    expect(reorderFields(["a", "b"], 0, 5)).toEqual(["a", "b"]);
    expect(reorderFields(["a", "b"], -1, 0)).toEqual(["a", "b"]);
  });
});
