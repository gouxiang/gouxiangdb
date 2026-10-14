// 顶栏全局搜索窄屏回归（node 环境，react-dom/server + vi.mock，无 jsdom、无新增依赖）。
//
// 锁的是 P1-B（D-1 后半 / 违反 R-D-33）：
//   ① <768 折叠为图标：原按钮是 `w-full max-w-md` + 长文案，窄屏被压到内容宽度以下后
//      中文逐字换行（与工具栏同一类断行），规范本档就要求「顶栏搜索折叠为图标」。
//   ② ≥768 形态一字未改：文案、⌘K 徽标、mx-auto 居中都在。
//   ③ 图标态必须保留可访问名称（读屏/自动化仍能定位到「搜索」）。

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";

vi.mock("../../components/LibrarySwitcher", () => ({ LibrarySwitcher: () => null }));
vi.mock("../settings/PersonalCenterDrawer", () => ({ PersonalCenterDrawer: () => null }));
// 品牌产品名 hook 走 react-query；本 SSR 回归不挂 QueryClientProvider，给默认名桩即可。
vi.mock("../branding/useBranding", () => ({ useProductName: () => "构想工作台" }));

import { WorkspaceTopBar } from "./WorkspaceTopBar";

function renderTopBar() {
  return render(
    <StaticRouter location="/base/b1">
      <WorkspaceTopBar onOpenSearch={() => undefined} />
    </StaticRouter>,
  );
}

describe("P1-B 顶栏全局搜索（R-D-33）", () => {
  it("<768 折叠为 32×32 图标按钮（w-8），≥768 仍是 w-full max-w-md", () => {
    const html = renderTopBar();
    expect(html).toContain("h-8 w-8");
    expect(html).toContain("md:w-full md:max-w-md");
  });

  it("文案与 ⌘K 徽标只在 ≥768 出现，窄屏不再参与换行", () => {
    const html = renderTopBar();
    expect(html).toContain("hidden min-w-0 flex-1 truncate whitespace-nowrap text-left md:block");
    expect(html).toContain("搜索记录、文档与画布");
    expect(html).toContain("md:inline-block");
    expect(html).toContain("⌘K");
  });

  it("图标态保留可访问名称与 tooltip，功能不因折叠而丢失", () => {
    const html = renderTopBar();
    expect(html).toContain('aria-label="搜索记录、文档与画布"');
    expect(html).toContain('title="搜索（⌘K）"');
  });
});
