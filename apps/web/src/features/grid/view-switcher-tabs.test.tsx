// 视图切换器「选项卡化」回归（node 环境：react-dom/server + 纯函数断言，无 jsdom、无新增依赖）。
//
// 锁的是本次交互改造的五条：
//   ① 视图由**横排选项卡**呈现，当前视图高亮（不再用单选下拉）
//   ② 每个视图带竖排「⋯」按钮 → 重命名 / 删除视图
//   ③ 末尾「+」选项卡 = 新建视图，且**常驻可见**（放在滚动容器之外，不靠 sticky）
//   ④ 选项卡区横向溢出可滚动
//   ⑤ 删除视图后的选中态迁移：删当前 → 迁到相邻位；删非当前 → 原地不动
//
// 断言口径与同目录既有测试一致：能 SSR 的一律真渲染后断言 DOM；删除后的迁移规则是纯函数
// nextViewAfterDelete，直接单测（这是"跳转确实发生"的真证据，不是源码字符串猜测）。

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { readFileSync } from "node:fs";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ViewDTO } from "@gx/shared-types";
import { ViewSwitcher, nextViewAfterDelete } from "./ViewSwitcher";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const countOf = (s: string, needle: string) => s.split(needle).length - 1;

const TABLE_ID = "t1";
const BASE_ID = "b1";

const view = (id: string, name: string): ViewDTO =>
  ({ id, tableId: TABLE_ID, name, type: "grid" }) as unknown as ViewDTO;

const VIEWS = [view("v1", "网格视图"), view("v2", "看板视图"), view("v3", "画廊视图")];

function renderSwitcher(viewId: string, canManageSchema: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 直接灌缓存：SSR 下 effect 不跑，useViews 不会真的发请求
  qc.setQueryData(["views", TABLE_ID], VIEWS);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/base/${BASE_ID}/table/${TABLE_ID}/view/${viewId}`]}>
        <ViewSwitcher
          baseId={BASE_ID}
          tableId={TABLE_ID}
          viewId={viewId}
          canManageSchema={canManageSchema}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("① 横排选项卡 + 当前视图高亮", () => {
  it("三个视图渲染成三个选项卡，非下拉（不再有 aria-haspopup 的单选触发器）", () => {
    const html = renderSwitcher("v2", true);
    expect(countOf(html, "data-gx-view-tab=")).toBe(3);
    for (const name of ["网格视图", "看板视图", "画廊视图"]) {
      expect(html).toContain(name);
    }
  });

  it("当前视图唯一高亮：active 只有一个，且只有它带 gx-accent 高亮态", () => {
    const html = renderSwitcher("v2", true);
    expect(countOf(html, 'data-gx-view-tab="active"')).toBe(1);
    expect(countOf(html, 'data-gx-view-tab="idle"')).toBe(2);

    // 取 active 选项卡自身的这段标签文本：必须是「看板视图」
    const activeSeg = html.split('data-gx-view-tab="active"')[1].split("</button>")[0];
    expect(activeSeg).toContain("看板视图");
    expect(activeSeg).toContain("bg-gx-accent-bg");
    expect(activeSeg).toContain("text-gx-accent");
    expect(activeSeg).toContain("font-medium");

    // 未选中的选项卡不得带高亮态
    const idleSeg = html.split('data-gx-view-tab="idle"')[1].split("</button>")[0];
    expect(idleSeg).toContain("网格视图");
    expect(idleSeg).not.toContain("bg-gx-accent-bg");
    expect(idleSeg).not.toContain("text-gx-accent");
  });
});

describe("② 每个视图的竖排「⋯」菜单", () => {
  it("有 canManageSchema：每个视图各一个「⋯」按钮（竖排省略号 moreVertical）", () => {
    const html = renderSwitcher("v2", true);
    expect(countOf(html, "data-gx-view-more")).toBe(3);
  });

  it("无 canManageSchema：「⋯」与「+」都不渲染（管理类入口隐藏，不是置灰）", () => {
    const html = renderSwitcher("v2", false);
    expect(html).not.toContain("data-gx-view-more");
    expect(html).not.toContain("data-gx-view-new");
    expect(html).not.toContain("aria-haspopup=\"menu\"");
    // 反例护栏：不许退化成 disabled 假入口
    const src = read("./ViewSwitcher.tsx");
    expect(src).not.toContain("disabled={!canManageSchema}");
    expect(src).toContain("{canManageSchema && (");
  });
});

describe("③ 末尾「+」新建视图选项卡常驻", () => {
  it("「+」只有一个，且排在所有选项卡之后（结构上在滚动容器外，不随滚动消失）", () => {
    const html = renderSwitcher("v2", true);
    expect(countOf(html, "data-gx-view-new")).toBe(1);
    const lastTab = html.lastIndexOf("data-gx-view-tab=");
    expect(html.indexOf("data-gx-view-new")).toBeGreaterThan(lastTab);
    // 与最后一个选项卡不在同一个滚动容器内：滚动容器先闭合，再渲染「+」
    expect(html.indexOf("overflow-x-auto")).toBeLessThan(html.indexOf("data-gx-view-new"));
    expect(html.indexOf("</div>")).toBeLessThan(html.indexOf("data-gx-view-new"));
  });

  it("选项卡区溢出可滚动（overflow-x-auto，滚动条隐藏）", () => {
    const html = renderSwitcher("v2", true);
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("scrollbar-width:none");
  });
});

describe("⑤ 删除视图后的选中态迁移（纯函数 nextViewAfterDelete）", () => {
  const ids = ["v1", "v2", "v3"].map((id) => ({ id }));

  it("删当前视图（中间位）→ 迁到后一位，不停在已删视图", () => {
    expect(nextViewAfterDelete(ids, "v2", "v2")).toEqual({ kind: "goto", viewId: "v3" });
  });

  it("删当前视图（首位）→ 迁到后一位", () => {
    expect(nextViewAfterDelete(ids, "v1", "v1")).toEqual({ kind: "goto", viewId: "v2" });
  });

  it("删当前视图（末位）→ 回退到前一位，不越界", () => {
    expect(nextViewAfterDelete(ids, "v3", "v3")).toEqual({ kind: "goto", viewId: "v2" });
  });

  it("删非当前视图 → 保持当前视图不变（stay，不跳转）", () => {
    expect(nextViewAfterDelete(ids, "v1", "v2")).toEqual({ kind: "stay" });
    expect(nextViewAfterDelete(ids, "v3", "v2")).toEqual({ kind: "stay" });
  });

  it("删掉最后一个（后端会拦，这里兜底）→ 回表首页", () => {
    expect(nextViewAfterDelete([{ id: "v1" }], "v1", "v1")).toEqual({ kind: "table" });
  });

  it("删除处理按迁移结果分派：goto 才跳转，stay 不动，table 回表首页", () => {
    const src = read("./ViewSwitcher.tsx");
    expect(src).toContain("nextViewAfterDelete(list, id, viewId)");
    expect(src).toMatch(/if \(next\.kind === "goto"\) goToView\(next\.viewId\)/);
    expect(src).toMatch(/else if \(next\.kind === "table"\) navigate\(/);
    // stay 分支不允许产生任何导航
    const body = src.slice(src.indexOf("async function removeView"), src.indexOf("async function removeView") + 1400);
    expect(body.match(/navigate\(/g)?.length ?? 0).toBe(1);
    expect(body.match(/goToView\(/g)?.length ?? 0).toBe(1);
  });
});
