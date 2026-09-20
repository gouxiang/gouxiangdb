// 第四批「丢失入口恢复」回归（node 环境，react-dom/server + vi.mock，无 jsdom、无新增依赖）。
//
// 第三批导航重构把 L2 换成 SecondaryNav / SecondaryNavSections 之后，旧壳 Sidebar
// （features/sidebar/Sidebar.tsx）与 KbTree（features/kb/KbTree.tsx）已无任何引用点，
// 挂在它们上面的能力整批失联。本文件锁的是把这些能力接回 L2 之后**不再丢**：
//   ① 表行菜单五项（重命名 / 编辑表单 / 复制表×2 / 清空数据 / 删除表）+ 面板头新建数据表
//   ② KB 文档拖拽改层级（拖到文档上成子级 / 拖到根区回顶级）
//   ③ KB 新建文档 / 画布按当前 tab 建对类型
//   ④ 导入导出收敛：工具栏常驻按钮 + L2 / 更多菜单不再重复
//   ⑤ 列表末尾回收站行按容器直跳
//
// hooks 全部给桩：本文件只断言「拿到数据/权限后渲染什么」与「动作接到哪个 mutation」，
// 不牵扯取数与真实网络。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";

let tables: { id: string; baseId: string; name: string; icon: string | null; iconColor: string | null }[] = [];
let docs: { id: string; kind: "doc" | "canvas"; title: string; parentId: string | null }[] = [];
let canManageSchema = true;
let kbRole: string = "owner";

vi.mock("../../api/hooks", () => ({
  useTables: (baseId: string | null) => ({
    data: baseId ? tables : undefined,
    isLoading: false,
    isError: false,
  }),
  useBase: () => ({ data: { permissions: { canManageSchema } } }),
  useGXMutations: () => ({
    createTable: { mutateAsync: vi.fn() },
    updateTable: { mutateAsync: vi.fn() },
    duplicateTable: { mutateAsync: vi.fn() },
    clearTable: { mutateAsync: vi.fn() },
    deleteTable: { mutateAsync: vi.fn() },
    restoreTrash: { mutateAsync: vi.fn() },
  }),
}));

vi.mock("../kb/kb-hooks", () => ({
  useKbDocs: (kbId: string | undefined) => ({
    data: kbId ? docs : undefined,
    isLoading: false,
    isError: false,
  }),
  useKb: () => ({ data: { role: kbRole } }),
  useCreateDoc: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMoveDoc: () => ({ mutateAsync: vi.fn() }),
}));

import { SecondaryNav, type SecondaryContainer } from "./SecondaryNav";

const BASE: SecondaryContainer = { kind: "base", id: "b1", name: "客户主数据库" };
const KB: SecondaryContainer = { kind: "kb", id: "k1", name: "产品知识库" };

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

function render(container: SecondaryContainer, location: string): string {
  return renderToString(
    <StaticRouter location={location}>
      <SecondaryNav container={container} onClose={vi.fn()} />
    </StaticRouter>,
  );
}

beforeEach(() => {
  tables = [];
  docs = [];
  canManageSchema = true;
  kbRole = "owner";
});

describe("① 表行菜单：旧壳 Sidebar 失联的五项能力回挂 L2", () => {
  const ops = read("./SecondaryNavTableOps.tsx");

  it("五项菜单齐全，且复用既有 mutation（不复制实现）", () => {
    for (const label of ["重命名", "编辑表单", "复制表（含数据）", "复制表（不含数据）", "清空数据", "删除表"]) {
      expect(ops).toContain(label);
    }
    // 全部走 useGXMutations 的既有封装——与旧壳 Sidebar / 现役 TopBar 同源
    for (const mut of [
      "m.updateTable",
      "m.duplicateTable",
      "m.clearTable",
      "m.deleteTable",
      "m.restoreTrash",
      "m.createTable",
    ]) {
      expect(ops).toContain(mut);
    }
    // 编辑表单走既有 ?design=1 能力（DetailView / TableIndexRedirect 已在用）
    expect(ops).toContain("?design=1");
  });

  it("清空走 L3『输入表名』、删除走 L2 软删 + 撤销，都是 feedback 的既有危险确认", () => {
    expect(ops).toContain("confirmClearTable(");
    expect(ops).toContain("confirmSoftDelete(");
    expect(ops).toContain("toastDeleted(");
    expect(ops).toContain("m.restoreTrash.mutateAsync");
    // 删完不能停在死路由：当前就在这张表上 → 回跳库首页
    expect(ops).toContain('navigate(`/base/${bid}`)');
  });

  it("有表结构权限：面板头出现新建入口、表行出现行菜单", () => {
    tables = [
      { id: "t1", baseId: "b1", name: "数据表 1", icon: null, iconColor: null },
      { id: "t2", baseId: "b1", name: "数据表 2", icon: null, iconColor: null },
    ];
    const html = render(BASE, "/base/b1/table/t1");
    expect(html).toContain("新建数据表");
    // 行菜单的可访问名按行给具体表名（P3-a11y 口径）
    expect(html).toContain('aria-label="数据表 1 表操作菜单"');
    expect(html).toContain('aria-label="数据表 2 表操作菜单"');
  });

  it("无表结构权限：新建入口与行菜单都不渲染（不是 disabled 假装禁用）", () => {
    canManageSchema = false;
    tables = [{ id: "t1", baseId: "b1", name: "数据表 1", icon: null, iconColor: null }];
    const html = render(BASE, "/base/b1/table/t1");
    expect(html).not.toContain("新建数据表");
    expect(html).not.toContain("表操作菜单");
    expect(ops).not.toContain("disabled={!canManageSchema}");
  });
});

describe("② KB 文档拖拽改层级（moveDoc 的 parentId）", () => {
  const kbOps = read("./SecondaryNavKbOps.tsx");

  it("走既有 useMoveDoc，且禁止拖到自己或自己的子树（防成环）", () => {
    expect(kbOps).toContain("useMoveDoc(");
    expect(kbOps).toContain("mutateAsync({ docId: from, parentId })");
    expect(kbOps).toContain("isSelfOrDescendant");
    expect(kbOps).toContain("无法移动：不能将文档放到它自己或它的子级中");
  });

  it("文档行可拖、画布行不可拖（画布不参与级联，不造后端没有的语义）", () => {
    docs = [
      { id: "d1", kind: "doc", title: "上线手册", parentId: null },
      { id: "d2", kind: "doc", title: "迭代记录", parentId: null },
      { id: "c9", kind: "canvas", title: "架构草图", parentId: null },
    ];
    const docTab = render(KB, "/kb/k1/doc/d1");
    expect(docTab).toContain('draggable="true"');
    // 文档 tab 下画布行根本不在列表里
    expect(docTab).not.toContain("架构草图");

    const canvasTab = render(KB, "/kb/k1/canvas/c9");
    expect(canvasTab).toContain("架构草图");
    expect(canvasTab).not.toContain('draggable="true"');
  });

  // P0-④：落区此前「常驻 DOM、靠 border/text-transparent 藏起来」，盒子照常占位，
  // 知识库文档列表顶部因此空出一大条。改为仅拖拽进行中才进 DOM。
  it("文档 tab 的「拖到此处移到顶级」根落区：静止态不进 DOM（不再白占一片）", () => {
    docs = [{ id: "d1", kind: "doc", title: "上线手册", parentId: null }];
    expect(render(KB, "/kb/k1")).not.toContain("拖到此处移到顶级");
  });

  it("根落区由 dragActive 门控；无写权限时整块不渲染", () => {
    // 拖拽中才有落区，dragActive 由 SecondaryNavKbOps 的 dragId 派生（已有单测锁 rowDrag 同源）
    expect(kbOps).toContain("dragActive");
    expect(kbOps).toContain("dragActive: dragId !== null");
    docs = [{ id: "d1", kind: "doc", title: "上线手册", parentId: null }];
    kbRole = "viewer";
    expect(render(KB, "/kb/k1")).not.toContain("拖到此处移到顶级");
  });
});

describe("③ KB 新建文档 / 画布：按当前选项卡建对类型", () => {
  it("文档 tab 出「新建文档」、画布 tab 出「新建画布」，二者互斥", () => {
    docs = [{ id: "d1", kind: "doc", title: "上线手册", parentId: null }];
    const docTab = render(KB, "/kb/k1/doc/d1");
    expect(docTab).toContain("新建文档");
    expect(docTab).not.toContain("新建画布");

    const canvasTab = render(KB, "/kb/k1/canvas/c9");
    expect(canvasTab).toContain("新建画布");
    expect(canvasTab).not.toContain("新建文档");
  });

  it("无创建权限（viewer）时不渲染新建入口", () => {
    kbRole = "viewer";
    expect(render(KB, "/kb/k1")).not.toContain("新建文档");
  });

  it("KbHomePage 的原入口已下线（同一能力不留两处）", () => {
    const home = read("../kb/KbHomePage.tsx");
    expect(home).not.toContain("useCreateDoc");
    expect(home).not.toContain('onClick={() => create("doc")}');
  });
});

describe("④ 导入 / 导出收敛：只有网格工具栏一处入口", () => {
  it("工具栏常驻「导入 / 导出」，「更多」菜单不再重复", () => {
    const src = read("../grid/GridToolbar.tsx");
    expect(src).toContain('<ToolButton icon="upload" label="导入" onClick={onImport} />');
    expect(src).toContain('<ToolButton icon="download" label="导出" onClick={onExport} />');
    expect(src).not.toContain('label="CSV 导入"');
    expect(src).not.toContain('label="CSV 导出"');
  });

  it("向导复用不重写：执行侧在 GridView，L2 操作行不再挂向导", () => {
    const grid = read("../grid/GridView.tsx");
    expect(grid).toContain("<ImportWizard");
    expect(grid).toContain("<ExportDialog");
    expect(grid).toContain("Tables.exportCsvText");
    expect(code("../workspace/TableActionRow.tsx")).not.toContain("ImportWizard");
    expect(code("../workspace/TableActionRow.tsx")).not.toContain("ExportDialog");
  });
});

describe("⑤ 回收站入口：按当前容器直跳", () => {
  it("base 容器跳 /base/:id/trash，kb 容器跳 /kb/:id/trash", () => {
    const nav = read("./SecondaryNav.tsx");
    expect(nav).toContain("`/base/${container.id}/trash`");
    expect(nav).toContain("`/kb/${container.id}/trash`");
  });

  it("列表末尾渲染回收站行，data 属性带容器类型（两种容器都能断言）", () => {
    const baseHtml = render(BASE, "/base/b1");
    expect(baseHtml).toContain("回收站");
    expect(baseHtml).toContain('data-l2-trash="base"');

    const kbHtml = render(KB, "/kb/k1");
    expect(kbHtml).toContain("回收站");
    expect(kbHtml).toContain('data-l2-trash="kb"');
  });

  it("两页路由都已存在（不是死链）", () => {
    const app = read("./../../App.tsx");
    expect(app).toContain('path="/base/:baseId/trash"');
    expect(app).toContain('path="/kb/:kbId/trash"');
  });
});
