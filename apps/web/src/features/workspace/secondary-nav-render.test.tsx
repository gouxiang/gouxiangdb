// 二级导航 SSR 回归（node + renderToString + vi.mock）。
//
// 第三批导航重构后锁的是新语义：
//   - 选中数据库 → 二级是该库下的**数据表**列表（数据源 useTables）；
//   - 选中知识库 → 二级是「文档 / 画布」两个选项卡 + 对应列表（数据源 useKbDocs）；
//   - 旧的「全部 / 未收纳 / 已收纳」三视角与其收纳计数徽标不再出现；
//   - 大列表行渲染仍然有界（窗口化，DOM 不随总量线性膨胀）。
//
// hooks 用 vi.mock 直接给数据：本组件与 SSR 回归都不跑 QueryClientProvider，
// 断言只针对「拿到数据后渲染什么」，不牵扯取数过程。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";

let tables: { id: string; baseId: string; name: string; icon: string | null; iconColor: string | null }[] = [];
let docs: { id: string; kind: "doc" | "canvas"; title: string; parentId: string | null }[] = [];
let docsKindSeen: string | undefined;

vi.mock("../../api/hooks", () => ({
  useTables: (baseId: string | null) => ({
    data: baseId ? tables : undefined,
    isLoading: false,
    isError: false,
  }),
  // 第四批：L2 回挂了表操作（新建 / 重命名 / 编辑表单 / 复制 / 清空 / 删除），
  // 需要 useBase 取 canManageSchema、useGXMutations 取那批 mutation。
  // SSR 回归不跑 QueryClientProvider，直接给桩（只断言渲染，不断言取数）。
  useBase: () => ({ data: { permissions: { canManageSchema: true } } }),
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
  useKbDocs: (kbId: string | undefined, kind?: "doc" | "canvas" | "all") => {
    docsKindSeen = kind;
    return { data: kbId ? docs : undefined, isLoading: false, isError: false };
  },
  // 第四批：L2 回挂了 KB 新建文档/画布（canCreate）与文档拖拽改层级（moveDoc）
  useKb: () => ({ data: { role: "owner" } }),
  useCreateDoc: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useMoveDoc: () => ({ mutateAsync: vi.fn() }),
}));

import { SecondaryNav, type SecondaryContainer } from "./SecondaryNav";

const BASE: SecondaryContainer = { kind: "base", id: "b1", name: "客户主数据库" };
const KB: SecondaryContainer = { kind: "kb", id: "k1", name: "产品知识库" };

function renderSecondary(container: SecondaryContainer, location = "/base/b1") {
  return renderToString(
    <StaticRouter location={location}>
      <SecondaryNav container={container} onClose={vi.fn()} />
    </StaticRouter>,
  );
}

function tableRow(i: number) {
  return { id: `t${i}`, baseId: "b1", name: `数据表 ${i}`, icon: null, iconColor: null };
}

beforeEach(() => {
  tables = [];
  docs = [];
  docsKindSeen = undefined;
});

describe("SecondaryNav：选中容器的子项（第三批语义）", () => {
  it("选中数据库 → 二级列出该库下的表，且没有「全部/未收纳/已收纳」收纳视角", () => {
    tables = [tableRow(1), tableRow(2)];
    const html = renderSecondary(BASE);

    expect(html).toContain("数据表 1");
    expect(html).toContain("数据表 2");
    expect(html).toContain("客户主数据库"); // 面板头是一级选中库的名字
    // 收纳语义整体下线：三视角 tab 不再存在
    expect(html).not.toContain("未收纳");
    expect(html).not.toContain("已收纳");
    expect(html).not.toContain("收藏");
    expect(html).not.toContain("最近");
    // 数据库没有第二种子内容：不渲染文档/画布选项卡
    expect(html).not.toContain("画布");
  });

  it("选中知识库 → 出现「文档 / 画布」两个选项卡，默认落在文档并拉全量（tab 只做本地过滤）", () => {
    docs = [
      { id: "d1", kind: "doc", title: "上线手册", parentId: null },
      { id: "d2", kind: "doc", title: "迭代记录", parentId: "d1" },
    ];
    const html = renderSecondary(KB, "/kb/k1");

    expect(html).toContain("产品知识库");
    expect(html).toContain("文档");
    expect(html).toContain("画布");
    // 改为断言 "all"（原断言 "doc"）：数据源改成拉全量，tab 切换不再换 queryKey 重取 ——
    // 否则「路由反推到画布 tab」会触发一次重新取数，L2 先空一下再出画布行，选中态仍会闪丢。
    expect(docsKindSeen).toBe("all");
    expect(html).toContain("上线手册");
    // 子文档折叠：有子节点时给出展开按钮，默认不摊开子级
    expect(html).toContain("展开");
    expect(html).not.toContain("迭代记录");
  });

  // P0-⑤ 真回归：此前 kbTab 是纯本地 state、从不与路由同步，进画布路由时 L2 停在「文档」tab，
  // 画布行既不在数据源过滤结果里也不在列表里 → 表现为「跳回文档列表、选中态丢失」。
  it("画布路由下 L2 停在画布 tab：画布行在列表里且带当前项语义", () => {
    docs = [
      { id: "d1", kind: "doc", title: "上线手册", parentId: null },
      { id: "c9", kind: "canvas", title: "架构草图", parentId: null },
    ];
    const html = renderSecondary(KB, "/kb/k1/canvas/c9");

    expect(html).toContain("架构草图");
    // 路由反推：画布 tab 被选中（文档 tab 未选中）
    expect(html).toContain('aria-selected="true"');
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1);
    // 选中态：当前画布行带 aria-current="page"
    expect(html).toContain('aria-current="page"');
    // 段头只出现「画布 1」这一段，不出现文档段
    expect(html).not.toContain("文档 1");
    expect(html).not.toContain("上线手册");
  });

  it("文档路由下 L2 停在文档 tab：文档行在列表里且当前项有 aria-current", () => {
    docs = [
      { id: "d1", kind: "doc", title: "上线手册", parentId: null },
      { id: "c9", kind: "canvas", title: "架构草图", parentId: null },
    ];
    const html = renderSecondary(KB, "/kb/k1/doc/d1");

    expect(html).toContain("上线手册");
    expect(html).not.toContain("架构草图");
    expect(html).toContain('aria-current="page"');
  });

  it("数据源拉全量后，画布子项不污染文档段的层级折叠", () => {
    // d1 只有一个画布子项 → 展开按钮必须是 invisible（无子节点），否则点了没反应
    docs = [
      { id: "d1", kind: "doc", title: "上线手册", parentId: null },
      { id: "c9", kind: "canvas", title: "架构草图", parentId: "d1" },
    ];
    const onlyCanvasKid = renderSecondary(KB, "/kb/k1/doc/d1");
    expect(onlyCanvasKid).toContain("上线手册");
    expect(onlyCanvasKid).toMatch(/rounded p-0\.5 invisible/);

    // 有真文档子项 → 展开按钮可见可点（对照组，防止上面写成「永远 invisible」的假通过）
    docs = [
      { id: "d1", kind: "doc", title: "上线手册", parentId: null },
      { id: "d2", kind: "doc", title: "迭代记录", parentId: "d1" },
    ];
    const withDocKid = renderSecondary(KB, "/kb/k1/doc/d1");
    expect(withDocKid).not.toMatch(/rounded p-0\.5 invisible/);
  });

  it("选中知识库且为空 → 空态给具体文案，不写泛泛的「暂无数据」", () => {
    const html = renderSecondary(KB, "/kb/k1");
    expect(html).toContain("还没有文档");
  });

  it("选中数据库但没有任何表 → 空态说明是「该数据库还没有数据表」", () => {
    const html = renderSecondary(BASE);
    expect(html).toContain("该数据库还没有数据表");
  });

  it("1200 张表：首帧只渲染有界行（窗口化，不全量 1200）", () => {
    tables = Array.from({ length: 1200 }, (_, i) => tableRow(i));
    const t0 = performance.now();
    const html = renderSecondary(BASE);
    const ms = performance.now() - t0;

    // 改断言原因：原先按「表名出现次数」计数，第四批给表行回挂了行菜单后，
    // 同一行的表名会多出现在 title / aria-label / 菜单可访问名里（一行 4 处），
    // 计数被放大 4 倍 —— 但那不是 DOM 变多。窗口化要锁的是「渲染了几行」，
    // 故改为数行元素本身（SecondaryRow 的定高 style，SECONDARY_ROW_H=31）。
    const rendered = (html.match(/height:31px/g) ?? []).length;
    expect(rendered).toBeGreaterThan(0);
    // 窗口：viewport≈31*24=744，可见 24 + overscan 24 → ≤48，留余量 ≤120（+1 个段头行）
    expect(rendered).toBeLessThanOrEqual(121);
    expect(rendered).toBeLessThan(1200 / 5);
    console.log(`[S10-metric] SecondaryNav SSR 1200 tables: renderedRows=${rendered}, render=${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(1000);
  });
});
