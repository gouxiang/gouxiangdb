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
}));

vi.mock("../kb/kb-hooks", () => ({
  useKbDocs: (kbId: string | undefined, kind?: "doc" | "canvas" | "all") => {
    docsKindSeen = kind;
    return { data: kbId ? docs : undefined, isLoading: false, isError: false };
  },
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

  it("选中知识库 → 出现「文档 / 画布」两个选项卡，默认落在文档并按 kind 取数", () => {
    docs = [
      { id: "d1", kind: "doc", title: "上线手册", parentId: null },
      { id: "d2", kind: "doc", title: "迭代记录", parentId: "d1" },
    ];
    const html = renderSecondary(KB, "/kb/k1");

    expect(html).toContain("产品知识库");
    expect(html).toContain("文档");
    expect(html).toContain("画布");
    expect(docsKindSeen).toBe("doc");
    expect(html).toContain("上线手册");
    // 子文档折叠：有子节点时给出展开按钮，默认不摊开子级
    expect(html).toContain("展开");
    expect(html).not.toContain("迭代记录");
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

    const rendered = (html.match(/数据表 \d+/g) ?? []).length;
    expect(rendered).toBeGreaterThan(0);
    // 窗口：viewport≈31*24=744，可见 24 + overscan 24 → ≤48，留余量 ≤120
    expect(rendered).toBeLessThanOrEqual(120);
    expect(rendered).toBeLessThan(1200 / 5);
    console.log(`[S10-metric] SecondaryNav SSR 1200 tables: renderedRows=${rendered}, render=${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(1000);
  });
});
