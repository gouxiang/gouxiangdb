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
//   ⑥ KB 文档 / 画布行尾菜单（重命名 / 图标与颜色 / 删除）回挂，表行行为不变
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
  // 行菜单（重命名 / 图标与颜色 / 删除）回挂后，KbOps 无条件调用这三个 hook；SSR 回归只给桩。
  useRenameDoc: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteDoc: () => ({ mutateAsync: vi.fn() }),
  useRestoreDoc: () => ({ mutateAsync: vi.fn() }),
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

  it("清空与删除都是 L3『输入表名』的同一口径（删除不再比清空松），并提供撤销", () => {
    expect(ops).toContain("confirmClearTable(");
    expect(ops).toContain("confirmDeleteTable(");
    expect(ops).toContain("toastDeleted(");
    expect(ops).toContain("m.restoreTrash.mutateAsync");
    // 强度倒挂护栏：删表不得退回 L2 的通用软删确认（此前误触删表比误触清空更容易得手）
    expect(ops).not.toContain("confirmSoftDelete(");
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

describe("⑥ KB 文档 / 画布行尾菜单：重命名 / 图标与颜色 / 删除回挂（表行行为不变）", () => {
  const kbOpsSrc = read("./SecondaryNavKbOps.tsx");
  const sectionsSrc = read("./SecondaryNavSections.tsx");
  const navSrc = read("./SecondaryNav.tsx");

  it("三项菜单齐全、图标语义正确，删除为 danger 且排在最后", () => {
    for (const label of ["重命名", "图标与颜色", "删除"]) {
      expect(kbOpsSrc).toContain(label);
    }
    // 内置 Icon 体系（非 emoji）：edit / palette / trash，删除走 danger 红字
    expect(kbOpsSrc).toContain('icon: "edit"');
    expect(kbOpsSrc).toContain('icon: "palette"');
    expect(kbOpsSrc).toContain('icon: "trash", label: "删除", danger: true');
  });

  it("全部复用 kb-hooks 现成能力与全局确认/撤销，不新造 fetch", () => {
    // 改名 / 图标走同一个 useRenameDoc 的字符串 patch 与对象 patch 双通道
    expect(kbOpsSrc).toContain("useRenameDoc(");
    expect(kbOpsSrc).toContain("mutateAsync(renaming.name.trim())");
    expect(kbOpsSrc).toContain("mutateAsync({ icon: next.icon, iconColor: next.iconColor })");
    // 删除：L2 可恢复确认 + useDeleteDoc + 撤销 toast（useRestoreDoc），与旧壳 KbTree.doDelete 同源
    expect(kbOpsSrc).toContain("useDeleteDoc(");
    expect(kbOpsSrc).toContain("useRestoreDoc(");
    expect(kbOpsSrc).toContain("confirmSoftDelete({");
    expect(kbOpsSrc).toContain("toastDeleted({");
    // 无目标时用哨兵 id 占位（同 KbTree），避免 useRenameDoc 指向真实文档
    expect(kbOpsSrc).toContain('"__none__"');
    // 删的是当前所在项 → 回跳库首页，不停死路由
    expect(kbOpsSrc).toContain('navigate(`/kb/${bid}`)');
    // 不允许裸 fetch
    expect(code("./SecondaryNavKbOps.tsx")).not.toContain("fetch(");
  });

  it("无写权限（viewer）时 rowMenuItems 恒返回 []，行尾不渲染三点（非 disabled 假入口）", () => {
    expect(kbOpsSrc).toContain("if (!canCreate) return [];");
  });

  it("行尾触发按钮用内置 moreVertical 图标，空 items 只渲染占位（显隐不改行宽）", () => {
    expect(sectionsSrc).toContain('<Icon name="moreVertical" size={14} />');
    expect(sectionsSrc).toContain("if (items.length === 0) return <span aria-hidden");
  });

  it("SecondaryNav 把 doc/canvas 行接到 kbOps.rowMenuItems，并按族给 a11y 菜单名", () => {
    expect(navSrc).toContain("kbOps.rowMenuItems({");
    expect(navSrc).toContain('${row.kind === "canvas" ? "画布" : "文档"}操作菜单');
  });

  it("有权限：doc 行与 canvas 行都渲染行尾三点触发按钮（按当前 tab 各自出现）", () => {
    docs = [
      { id: "d1", kind: "doc", title: "上线手册", parentId: null },
      { id: "c9", kind: "canvas", title: "架构草图", parentId: null },
    ];
    // 文档 tab：文档行有「文档操作菜单」触发按钮，画布行不在本 tab 列表
    const docTab = render(KB, "/kb/k1/doc/d1");
    expect(docTab).toContain('aria-label="上线手册 文档操作菜单"');
    expect(docTab).not.toContain("画布操作菜单");

    // 画布 tab：画布行有「画布操作菜单」触发按钮
    const canvasTab = render(KB, "/kb/k1/canvas/c9");
    expect(canvasTab).toContain('aria-label="架构草图 画布操作菜单"');
    expect(canvasTab).not.toContain("文档操作菜单");
  });

  it("无写权限（viewer）：doc/canvas 行尾都不渲染三点入口", () => {
    kbRole = "viewer";
    docs = [
      { id: "d1", kind: "doc", title: "上线手册", parentId: null },
      { id: "c9", kind: "canvas", title: "架构草图", parentId: null },
    ];
    expect(render(KB, "/kb/k1/doc/d1")).not.toContain("文档操作菜单");
    expect(render(KB, "/kb/k1/canvas/c9")).not.toContain("画布操作菜单");
  });

  it("表行菜单行为不变：base 容器仍是表操作菜单，且不泄漏 KB 菜单标签", () => {
    tables = [{ id: "t1", baseId: "b1", name: "数据表 1", icon: null, iconColor: null }];
    const html = render(BASE, "/base/b1/table/t1");
    expect(html).toContain('aria-label="数据表 1 表操作菜单"');
    expect(html).not.toContain("文档操作菜单");
    expect(html).not.toContain("画布操作菜单");
  });
});
