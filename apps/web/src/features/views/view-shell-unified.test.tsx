// 统一视图外壳回归（node 环境：react-dom/server + 源码断言，无 jsdom、无新增依赖）。
//
// 锁的是 2026-09-21 产品走查三条：
//   ① 非网格视图（kanban / calendar / gallery / form / detail）也在统一框架内：
//      同样有第一行视图标签条 + 第二行主工具栏（新建记录 / 搜索 / 导入 / 导出 / 更多）。
//      这五类原先裸奔——标签条与工具栏是 GridView 的私有子树。
//   ② 行合并：「新建记录」与「搜索 / 导入 / 导出 / 更多」同一行（新建记录在左，其余靠右）。
//   ③ 「新建记录」不再被 pointer-events-none 静默吞掉点击（disabled + 原因仍然保留）。
//
// 断言口径与同目录既有测试一致：能 SSR 的一律真渲染后断言 DOM，做不到（浮层要点开才挂载）
// 的才退到源码断言。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PermissionSet, ViewConfig, ViewDTO } from "@gx/shared-types";
import { ViewShell } from "./ViewShell";
import KanbanView from "./KanbanView";
import FormView from "./FormView";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** 只取代码本体：注释里保留的「考古说明」不参与判定（与 designer/field-editor-dirty 同口径）。 */
const code = (p: string) =>
  read(p)
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
const countOf = (s: string, needle: string) => s.split(needle).length - 1;

const BASE_ID = "b1";
const TABLE_ID = "t1";

const view = (id: string, name: string, type: string): ViewDTO =>
  ({ id, tableId: TABLE_ID, name, type, config: viewConfig() }) as unknown as ViewDTO;

const viewConfig = (): ViewConfig =>
  ({
    hiddenFieldIds: [],
    fieldOrder: [],
    rowHeight: "medium",
    filters: null,
    sorts: [],
    search: "",
    groupByFieldId: null,
    collapsedGroupKeys: [],
    aggregations: {},
    rowColor: { mode: "none", fieldId: null, rules: [] },
    coverFieldId: null,
  }) as unknown as ViewConfig;

const VIEWS = [
  view("v1", "网格视图", "grid"),
  view("v2", "看板视图", "kanban"),
  view("v3", "日历视图", "calendar"),
];

const PERM_ALL: PermissionSet = {
  canManageBase: true,
  canManageSchema: true,
  canEditData: true,
  canComment: true,
  canView: true,
};

const PERM_READ: PermissionSet = { ...PERM_ALL, canEditData: false, canManageSchema: false };

/** 子视图 props（与 ViewRouter 的 viewProps 同构） */
function baseViewProps(target: ViewDTO) {
  return {
    baseId: BASE_ID,
    tableId: TABLE_ID,
    viewId: target.id,
    view: target,
    permissions: PERM_ALL,
    onOpenRecord: () => undefined,
  };
}

/** SSR 渲染外壳：children 用一个探针节点代替真实视图，只验外壳自己贡献的两行 */
function renderShell(viewId: string, permissions: PermissionSet) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["views", TABLE_ID], VIEWS);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/base/${BASE_ID}/table/${TABLE_ID}/view/${viewId}`]}>
        <ViewShell
          baseId={BASE_ID}
          tableId={TABLE_ID}
          viewId={viewId}
          view={VIEWS.find((v) => v.id === viewId)!}
          permissions={permissions}
        >
          {() => <span>__VIEW_CONTENT__</span>}
        </ViewShell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("① 非网格视图也在统一框架内", () => {
  it("看板视图同样渲染第一行视图标签条（六类视图都有）", () => {
    const html = renderShell("v2", PERM_ALL);
    // 标签条行容器 + 三个视图选项卡（看板不再是"裸列表页"）
    expect(html).toContain("data-gx-toolbar-view-row");
    expect(countOf(html, "data-gx-view-tab=")).toBe(3);
  });

  it("看板视图同样有第二行：新建记录 + 搜索 / 导入 / 导出 / 更多", () => {
    const html = renderShell("v2", PERM_ALL);
    for (const label of ["新建记录", "搜索此视图", "导入", "导出", "更多"]) {
      expect(html).toContain(label);
    }
  });

  it("内容区照旧渲染在两行之下", () => {
    const html = renderShell("v2", PERM_ALL);
    expect(html.indexOf("data-gx-toolbar-view-row")).toBeLessThan(html.indexOf("__VIEW_CONTENT__"));
    expect(html.indexOf("新建记录")).toBeLessThan(html.indexOf("__VIEW_CONTENT__"));
  });
});

describe("② 行合并：新建记录与搜索 / 导入 / 导出 / 更多同一行", () => {
  it("新建记录在最左，搜索 / 导入 / 导出 / 更多用 ml-auto 靠右", () => {
    const html = renderShell("v1", PERM_ALL);
    expect(html.indexOf("新建记录")).toBeLessThan(html.indexOf("搜索此视图"));
    expect(html.indexOf("搜索此视图")).toBeLessThan(html.indexOf("导入"));
    expect(html.indexOf("导入")).toBeLessThan(html.indexOf("导出"));
    expect(html.indexOf("导出")).toBeLessThan(html.indexOf("更多"));
  });

  it("新建记录已从设置行移出（设置行只剩六个呈现设置项）", () => {
    const src = code("../grid/GridToolbarSettingsRow.tsx");
    expect(src).not.toContain("新建记录");
    expect(src).not.toContain("onNewRecord");
    // 六个设置项一个不少
    for (const label of ["行高", "字段", "筛选", "分组", "排序", "行颜色"]) {
      expect(src).toContain(`label="${label}"`);
    }
  });
});

describe("③ 新建记录不再被 pointer-events-none 吞掉点击", () => {
  it("工具栏源码里不再出现 pointer-events-none", () => {
    const src = code("../grid/GridToolbar.tsx") + code("../grid/GridToolbarSettingsRow.tsx");
    expect(src).not.toContain("pointer-events-none");
  });

  it("无编辑权限时仍是 disabled + 原因提示（不隐藏、不静默）", () => {
    const html = renderShell("v1", PERM_READ);
    expect(html).toContain("新建记录");
    expect(html).toContain("无编辑权限");
    expect(html).toContain("disabled");
    // 导入是写入口：无权限不渲染（PERM-A1）
    expect(html).not.toContain("导入");
    // 导出是读派生，不受门控
    expect(html).toContain("导出");
  });

  it("SSR 冒烟：六种权限 / 视图组合都能渲染，门控本身不抛错", () => {
    for (const v of VIEWS) {
      for (const p of [PERM_ALL, PERM_READ]) {
        const html = renderShell(v.id, p);
        expect(html).toContain("data-gx-toolbar-view-row");
        expect(html).toContain("新建记录");
      }
    }
  });
});

describe("⑤ 真视图组合冒烟：外壳 + 非网格子视图不崩", () => {
  /** 用真实子视图渲染（缓存为空 → 子视图走自己的加载态），只验外壳两行与子视图共存 */
  function renderWith(child: "kanban" | "form") {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["views", TABLE_ID], VIEWS);
    const target = child === "kanban" ? view("v2", "看板视图", "kanban") : view("v4", "表单视图", "form");
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/base/${BASE_ID}/table/${TABLE_ID}/view/${target.id}`]}>
          <ViewShell
            baseId={BASE_ID}
            tableId={TABLE_ID}
            viewId={target.id}
            view={target}
            permissions={PERM_ALL}
          >
            {() => (child === "kanban" ? <KanbanView {...baseViewProps(target)} /> : <FormView {...baseViewProps(target)} />)}
          </ViewShell>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("看板视图：外壳两行 + 看板内容同屏（不再是裸列表页）", () => {
    const html = renderWith("kanban");
    expect(html).toContain("data-gx-toolbar-view-row");
    expect(html).toContain("新建记录");
    expect(html).toContain("搜索此视图");
    // 看板自己的内容区（未配置分组字段时是「设置看板分组字段」引导空态）渲染在外壳两行之下
    expect(html).toContain("设置看板分组字段");
    expect(html.indexOf("新建记录")).toBeLessThan(html.indexOf("设置看板分组字段"));
  });

  it("表单视图：同样在统一框架内（外壳两行不缺席）", () => {
    const html = renderWith("form");
    expect(html).toContain("data-gx-toolbar-view-row");
    expect(html).toContain("新建记录");
    expect(html).toContain("导出");
  });
});

describe("④ 源码护栏：外壳是六类视图的唯一框架", () => {
  it("ViewRouter 把六类视图全部交给 ViewShell 包裹", () => {
    const src = read("./ViewRouter.tsx");
    expect(src).toContain("<ViewShell");
    for (const type of ["grid", "gallery", "kanban", "calendar", "form", "detail"]) {
      expect(src).toContain(`case "${type}":`);
    }
    // 旧写法（六类视图各自裸奔 + 只有 GridView 自带工具栏）已移除
    expect(src).not.toContain("let content;");
  });

  it("外壳只提供前两行；网格专属设置行由 GridView 渲染（仅 grid 出现）", () => {
    expect(read("./ViewShell.tsx")).not.toContain("GridToolbarSettingsRow");
    const grid = read("../grid/GridView.tsx");
    expect(grid).toContain("<GridToolbarSettingsRow");
    // 勾选后整行换成批量条，不会同时出现
    expect(grid).toContain("selection.count > 0 ?");
  });

  it("外壳挂载一份导入 / 导出向导，六类视图共用（执行侧仍在 GridView）", () => {
    expect(read("./ViewShell.tsx")).toContain("<TableViewIoDialogs");
    expect(read("../grid/GridView.tsx")).toContain("Tables.exportCsvText");
  });
});
