// 顶栏命令条窄屏回归（node 环境，react-dom/server + vi.mock，无 jsdom、无新增依赖）。
//
// v6 S3：顶栏按底板 .topbar/.cmd 重做，本文件锁：
//   ① <768 命令条折叠为 32×32 纯图标（.gx-cmd 移动优先在 index.css 给 32 宽，ph/kbd hidden）；
//   ② ≥768 文案与 ⌘K 出现（md:block / md:inline-block），文案用产品 SearchDialog 真口径
//      「搜索表格记录、知识库文档与画布」（不抄底板"成员"）；
//   ③ 图标态保留可访问名称（读屏/自动化仍能定位「搜索」）；
//   ④ 面包屑：/base/:id 且传入 containerName 时渲染 gx-crumb + 库名；不传时零段不渲染 nav；
//   ⑤ 帮助中心入口（gx-top-icon-btn + /help）与个人中心 .gx-who 都在；无通知铃。

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup as render } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";

vi.mock("../../components/LibrarySwitcher", () => ({ LibrarySwitcher: () => null }));
vi.mock("../settings/PersonalCenterDrawer", () => ({ PersonalCenterDrawer: () => null }));
// TopBar 的表名/文档名走 react-query；SSR 回归不挂 QueryClientProvider，按 shell-stage1
// 同口径给空列表桩（hook 内 enabled 门控在无 id 时本就不取数）。
vi.mock("../../api/hooks", () => ({
  useTables: () => ({ data: [], isLoading: false, isError: false }),
}));
vi.mock("../kb/kb-hooks", () => ({
  useKbDocs: () => ({ data: [], isLoading: false, isError: false }),
}));

import { WorkspaceTopBar } from "./WorkspaceTopBar";

function renderTopBar(location = "/base/b1", props: Record<string, unknown> = {}) {
  return render(
    <StaticRouter location={location}>
      <WorkspaceTopBar onOpenSearch={() => undefined} {...props} />
    </StaticRouter>,
  );
}

describe("v6 S3 顶栏命令条（R-D-33）", () => {
  it("<768 折叠为图标（.gx-cmd + 32 尺寸由 CSS 媒体查询承载），≥768 文案/ph/kbd 类在", () => {
    const html = renderTopBar();
    expect(html).toContain("gx-cmd");
    // ph 与 kbd 仅 md 起出现（类名上的 md: 断点）
    expect(html).toContain("gx-cmd-ph hidden md:block");
    expect(html).toContain("gx-kbd hidden md:inline-block");
  });

  it("文案是产品真实口径「搜索表格记录、知识库文档与画布」，且 ⌘K 徽标在", () => {
    const html = renderTopBar();
    expect(html).toContain("搜索表格记录、知识库文档与画布");
    expect(html).toContain("⌘K");
    // 不允许抄底板"成员"文案
    expect(html).not.toContain("成员");
  });

  it("图标态保留可访问名称与 tooltip，功能不因折叠而丢失", () => {
    const html = renderTopBar();
    expect(html).toContain('aria-label="搜索表格记录、知识库文档与画布"');
    expect(html).toContain('title="搜索（⌘K）"');
  });
});

describe("v6 S3 顶栏面包屑（gx-crumb）", () => {
  it("/base/:id 且 containerName 就绪：渲染 nav + 库名单段 c2", () => {
    const html = renderTopBar("/base/b1", {
      containerName: "默认库",
      containerKind: "base",
    });
    expect(html).toContain('class="gx-crumb"');
    expect(html).toContain('aria-label="面包屑"');
    expect(html).toContain("默认库");
    expect(html).toContain("gx-crumb-c2");
  });

  it("不传 containerName（库名未就绪/工作区级页面）：零段，不渲染 nav", () => {
    const html = renderTopBar("/base/b1");
    expect(html).not.toContain('aria-label="面包屑"');
    expect(html).not.toContain("gx-crumb");
  });
});

describe("v6 S3 顶栏右段", () => {
  it("帮助中心链接到 /help；个人中心走 .gx-who（含头像/名字/chevron）；无通知铃", () => {
    const html = renderTopBar("/base/b1", { containerName: "默认库", containerKind: "base" });
    expect(html).toContain('href="/help"');
    expect(html).toContain('aria-label="帮助中心"');
    expect(html).toContain("gx-top-icon-btn");
    expect(html).toContain("gx-top-vline");
    expect(html).toContain("gx-who");
    expect(html).toContain('aria-label="打开个人中心"');
    // 产品无通知功能：不允许放假铃入口
    expect(html).not.toContain("通知");
  });
});
