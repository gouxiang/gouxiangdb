// apps/web/src/features/tree/__tests__/tree-view.test.tsx
// 层级视图组件级测试：未配置父字段 -> Setup 引导；配置后 -> 按层级渲染节点名；
// 无 canEditData -> 不出现改父选择器。
//
// harness 约定（同 features/views/__tests__/view-guard-hook-order.test.tsx）：本仓 web 侧
// vitest 跑 node 环境，依赖树中没有 jsdom / @testing-library/react，仓库既有视图组件测试
// 统一用 react-dom/server 的 renderToStaticMarkup + vi.mock 数据替身渲染真实组件——
// 这里渲染的是 TreeView 本体（非纯函数），断言真实 DOM 输出，不引新依赖。

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { defaultViewConfig } from "@gx/shared-types";
import type { FieldDTO, RecordDTO, ViewDTO } from "@gx/shared-types";
import type { ViewProps } from "../../views/field-controls";

const TBL = "tbl-1";
const PARENT_FIELD_ID = "fld-parent";
const TITLE_FIELD_ID = "fld-title";

function makeRecords(): RecordDTO[] {
  // A(根) -> B -> C；D(根)。父字段 hydrate 为 LinkRef[]。
  const mk = (id: string, title: string, parent: RecordDTO | null): RecordDTO =>
    ({
      id,
      tableId: TBL,
      fields: {
        [TITLE_FIELD_ID]: title,
        [PARENT_FIELD_ID]: parent ? [{ tableId: TBL, recordId: parent.id }] : [],
      },
      createdAt: "",
    }) as unknown as RecordDTO;
  const a = mk("rec-a", "节点A", null);
  const b = mk("rec-b", "节点B", a);
  const c = mk("rec-c", "节点C", b);
  const d = mk("rec-d", "节点D", null);
  return [a, b, c, d];
}

const parentField: FieldDTO = {
  id: PARENT_FIELD_ID,
  tableId: TBL,
  name: "上级",
  type: "links",
  isReverse: false,
  relatedTableId: TBL,
} as unknown as FieldDTO;
const titleField: FieldDTO = {
  id: TITLE_FIELD_ID,
  tableId: TBL,
  name: "名称",
  type: "text",
} as unknown as FieldDTO;

const records: RecordDTO[] = makeRecords();
let fields: FieldDTO[] = [parentField, titleField];
let canEditData = true;

vi.mock("../../../api/hooks", () => ({
  useFields: () => ({ data: fields.length ? fields : undefined }),
  useGXMutations: () => ({
    updateView: { mutateAsync: vi.fn(async () => undefined) },
    updateRecord: { mutateAsync: vi.fn(async () => undefined) },
    createRecord: { mutateAsync: vi.fn(async () => undefined) },
  }),
}));
vi.mock("../../../api/records-paging-hooks", () => ({
  useRecordsBounded: () => ({
    records,
    fields,
    bounded: false,
    declaredTotal: records.length,
    isLoading: false,
    degraded: [],
  }),
}));

import TreeView from "../TreeView";

function renderTree(parentFieldId: string | null): string {
  const view = {
    id: "view-1",
    tableId: TBL,
    name: "层级",
    type: "tree",
    lockMode: "collaborative",
    order: 0,
    config: defaultViewConfig({
      treeParentFieldId: parentFieldId,
      cardFieldIds: [TITLE_FIELD_ID],
    }),
    createdAt: "",
  } as ViewDTO;
  const props: ViewProps = {
    baseId: "base-1",
    tableId: TBL,
    viewId: "view-1",
    view,
    permissions: {
      canManageBase: true,
      canManageSchema: true,
      canEditData,
      canComment: true,
      canView: true,
    },
  };
  return renderToStaticMarkup(React.createElement(TreeView, props));
}

describe("TreeView 未配置父字段", () => {
  it("显示 Setup 引导文案与字段选择器，不渲染树节点", () => {
    const html = renderTree(null);
    expect(html).toContain("设置层级父级字段");
    expect(html).toContain("<select");
    expect(html).toContain("上级"); // 可选项列出指向本表的 link 字段
    expect(html).not.toContain("节点A");
  });

  it("配置了 id 但字段不存在（首帧 fields 空）时也走 Setup，不崩溃", () => {
    const savedFields = fields;
    fields = [];
    try {
      const html = renderTree(PARENT_FIELD_ID);
      expect(html).toContain("设置层级父级字段");
    } finally {
      fields = savedFields;
    }
  });
});

describe("TreeView 配置后按层级渲染", () => {
  it("渲染全部节点名", () => {
    const html = renderTree(PARENT_FIELD_ID);
    for (const name of ["节点A", "节点B", "节点C", "节点D"]) {
      expect(html).toContain(name);
    }
  });

  it("父节点在其子节点之前出现（深度优先序）", () => {
    const html = renderTree(PARENT_FIELD_ID);
    expect(html.indexOf("节点A")).toBeLessThan(html.indexOf("节点B"));
    expect(html.indexOf("节点B")).toBeLessThan(html.indexOf("节点C"));
  });

  it("深层节点带层级缩进（padding-left 随 depth 递增）", () => {
    const html = renderTree(PARENT_FIELD_ID);
    expect(html).toContain("padding-left:16px"); // depth=1
    expect(html).toContain("padding-left:32px"); // depth=2
  });

  it("有子节点的行渲染展开 chevron", () => {
    const html = renderTree(PARENT_FIELD_ID);
    expect(html).toContain("aria-expanded=\"true\"");
  });
});

describe("TreeView 权限门控", () => {
  it("canEditData=false 时不出现改父选择器", () => {
    canEditData = false;
    try {
      const html = renderTree(PARENT_FIELD_ID);
      expect(html).not.toContain("修改父级");
      expect(html).not.toContain("无（根）");
      // 节点本身仍可查看
      expect(html).toContain("节点A");
    } finally {
      canEditData = true;
    }
  });
});
