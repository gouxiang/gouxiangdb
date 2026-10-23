// 工作区设置「分区口径」治理回归（node：react-dom/server + vi.mock + 源码断言，无新增依赖）。
//
// 锁的是两条口径——本轮「点左侧右侧空白 / 非 owner 直戳分区白屏」的根因：
//   A. 未知 splat 一律落「通用」（/workspace/settings 与 /workspace/settings/<垃圾>）
//   B. gated 分区的渲染判定不看 URL 原始 section，只看 effectiveSection：
//      非 owner 直戳 search / 非企业环境直戳 mcp → 回落通用且右内容非空
//
// 断言 effectiveSection 由 visibleSections 反查（单一真源），新增 gated 分区只要在
// SECTIONS 上打标记就自动受约束，不需要再改第二处三元判断。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { existsSync, readFileSync } from "node:fs";

let enterpriseOn = false;
let isOwner = false;
let manageMenu = false;

vi.mock("../contacts/contacts-hooks", () => ({
  useMyOrgActions: () => ({
    actions: new Set(manageMenu ? ["manage_menu"] : []),
    isSuperAdmin: true,
    isLoading: false,
  }),
  useIsWorkspaceOwner: () => ({ isOwner, isLoading: false }),
}));

// 部分 mock：只替换 useReindex（避免真发重建请求），其余钩子取真实实现。
// 不能用全量 mock——owner 直戳 /search 时语义检索面板真的会渲染，
// 少一个 useEmbeddingConfig/useSearchStatus 就会整个页面渲染失败。
vi.mock("../search/search-admin-hooks", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useReindex: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

// 分区门控要读 useAuthzCapability（权限分区），这里给确定值，不发请求。
vi.mock("../authz/useAuthzCapability", () => ({
  useAuthzCapability: () => ({ canManage: true }),
}));
// PermPanel 内嵌后依赖自己的 useState 子树，本组用例只关心分区渲染位置，桩掉即可。
vi.mock("../authz/PermPanel", () => ({
  default: () => <div data-perm-panel-embedded="1" />,
}));

// 系统更新面板本体有自己的五态测试；门控用例只关心分区显隐，桩掉避免拉真实 query。
vi.mock("../update/UpdatePanel", () => ({
  UpdatePanel: () => <div data-update-panel="1">检查并下载新版本安装包</div>,
}));

// 品牌外观面板：门控用例走真实挂载（BrandingSettingsPanel 内部 useIsWorkspaceOwner 复用本文件
// 对 contacts-hooks 的 mock，SSR 下 adminConfig queryFn 不执行、有 placeholderData 兜底，可稳挂；
// 面板自身的 owner 双保险/字段渲染由 branding/BrandingSettingsPanel.test.tsx 专测。

vi.mock("../settings/pat-hooks", () => ({
  useEnterpriseOrgFlag: () => enterpriseOn,
  usePatList: () => ({ data: [], isLoading: false }),
  useCreatePat: () => ({ mutate: vi.fn(), isPending: false }),
  useRevokePat: () => ({ mutate: vi.fn(), isPending: false }),
  normalizePatError: () => ({ status: 0, code: null, message: null }),
}));

import { WorkspaceSettingsPage } from "./WorkspaceSettingsPage";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const pageSrc = read("./WorkspaceSettingsPage.tsx");

/** 通用分区的锚点文案：右内容「有内容」的判据 */
const GENERAL = "权限与语义检索都在这里配置";

function renderPage(location = "/workspace/settings"): string {
  // 资产/导航子页内部用 useQuery（SSR 不跑 queryFn），需要 QueryClient 上下文。
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={qc}>
      <StaticRouter location={location}>
        <Routes>
          <Route
            path="/workspace/settings/*"
            element={<WorkspaceSettingsPage />}
          />
        </Routes>
      </StaticRouter>
    </QueryClientProvider>,
  ).replace(/<!--[^>]*-->/g, "");
}

beforeEach(() => {
  enterpriseOn = false;
  isOwner = false;
  manageMenu = false;
});

describe("A. 未知 / 空 splat 一律落通用", () => {
  it("/workspace/settings（无 splat）→ 通用", () => {
    expect(renderPage()).toContain(GENERAL);
  });

  it("/workspace/settings/<未知 splat> → 通用，且不渲染任何其它分区", () => {
    const html = renderPage("/workspace/settings/not-a-section");
    expect(html).toContain(GENERAL);
    expect(html).not.toContain("智能数据库");
    expect(html).not.toContain("回收站");
    expect(html).not.toContain("打开通讯录");
  });

  it("可解析的 splat 集合由 SECTIONS 推导（新增分区不需再改解析处）", () => {
    expect(pageSrc).toContain("SECTION_KEYS.includes(splat");
    // 不允许回到逐个字符串比对的写法（漏一个就会出现「新分区解析不出来」）
    expect(pageSrc).not.toMatch(/splat === "contacts"/);
  });
});

describe("B. gated 分区只看 effectiveSection（不看 URL 原始 section）", () => {
  it("非 owner 直戳 /search → 回落通用，右内容非空（不再整块空白）", () => {
    isOwner = false;
    const html = renderPage("/workspace/settings/search");
    expect(html).toContain(GENERAL);
    expect(html).not.toContain("配置云端语义检索");
  });

  it("非企业环境直戳 /mcp → 回落通用，右内容非空", () => {
    enterpriseOn = false;
    const html = renderPage("/workspace/settings/mcp");
    expect(html).toContain(GENERAL);
    expect(html).not.toContain("为 AI 客户端签发访问令牌");
  });

  it("owner 直戳 /search 仍然进得去（守卫没有反向误杀）", () => {
    isOwner = true;
    expect(renderPage("/workspace/settings/search")).toContain(
      "配置云端语义检索",
    );
  });

  // 门控放宽：语义检索从 ownerOnly 改为「持任一 manage_* 组织动作」（canSeeWorkspaceSettings 同口径）。
  it("非 owner 但持任一 manage_* 动作：/search 进得去（放宽不是收紧）", () => {
    isOwner = false;
    manageMenu = true;
    expect(renderPage("/workspace/settings/search")).toContain(
      "配置云端语义检索",
    );
  });

  it("非 owner 且无任一管理动作：左栏不出现语义检索分区（fail-closed，不做 disabled 假入口）", () => {
    isOwner = false;
    manageMenu = false;
    const html = renderPage();
    expect(html).not.toContain("云端语义检索与索引覆盖度");
  });

  it("企业环境直戳 /mcp 仍然进得去", () => {
    enterpriseOn = true;
    expect(renderPage("/workspace/settings/mcp")).toContain(
      "为 AI 客户端签发访问令牌",
    );
  });

  // 品牌外观分区 ownerOnly（#754）：后端只认 super_admin/admin/legacy owner，不认 manage_*。
  it("非 owner：左栏不出现品牌外观分区，直戳 /branding 回落通用", () => {
    isOwner = false;
    manageMenu = true; // 即便持 manage_* 动作也不见（ownerOnly，不是 manageOnly）
    const nav = renderPage();
    expect(nav).not.toContain("品牌外观");
    const direct = renderPage("/workspace/settings/branding");
    expect(direct).toContain(GENERAL);
    // 真挂面板：非 owner 时组件双保险 return null，不应出现面板字段
    expect(direct).not.toContain("产品显示名称");
  });

  it("owner：左栏出现品牌外观分区（在通用之下），直戳 /branding 进得去", () => {
    isOwner = true;
    expect(renderPage()).toContain("品牌外观");
    const direct = renderPage("/workspace/settings/branding");
    // 真挂面板（非桩）：owner 下出现面板字段锚点
    expect(direct).toContain("产品显示名称");
    expect(direct).toContain("自定义全站产品名、版权信息与登录页广告图");
  });

  // 系统更新分区 ownerOnly：与「权限管理」同口径，非 owner 不做 disabled 假入口。
  it("非 owner：左栏不出现系统更新分区，直戳 /update 回落通用", () => {
    isOwner = false;
    const nav = renderPage();
    expect(nav).not.toContain("系统更新");
    const direct = renderPage("/workspace/settings/update");
    expect(direct).toContain(GENERAL);
    expect(direct).not.toContain("data-update-panel");
  });

  it("owner：左栏出现系统更新分区，直戳 /update 进得去", () => {
    isOwner = true;
    expect(renderPage()).toContain("系统更新");
    expect(renderPage("/workspace/settings/update")).toContain(
      "data-update-panel",
    );
  });

  // 通讯录、资产与回收站分区已移除（一级导航已有通讯录入口；单库设置改由 L1「…」菜单进入；
  // 回收站与数据库/知识库各自就近的回收站重复）。旧链接一律回落通用，不白屏、不留死链。
  it("已下线的 /contacts、/assets 与 /trash 分区直戳都回落通用，不空白", () => {
    isOwner = true;
    const contacts = renderPage("/workspace/settings/contacts");
    expect(contacts).toContain(GENERAL);
    expect(contacts).not.toContain("data-contacts-directory");
    const assets = renderPage("/workspace/settings/assets");
    expect(assets).toContain(GENERAL);
    expect(assets).not.toContain("智能数据库");
    const trash = renderPage("/workspace/settings/trash");
    expect(trash).toContain(GENERAL);
    expect(trash).not.toContain("数据库回收站");
    expect(trash).not.toContain("知识库回收站");
  });

  it("effectiveSection 由 visibleSections 反查得出（单一真源）", () => {
    // 容忍 prettier 对长表达式的换行排版
    expect(pageSrc).toMatch(
      /visibleSections\.some\(\s*\(s\)\s*=>\s*s\.key\s*===\s*section/,
    );
    expect(pageSrc).not.toContain('section === "search" && !isOwner');
  });

  it("右内容渲染判定一律走 effectiveSection，不允许残留 `{section ===`", () => {
    expect(pageSrc).not.toMatch(/\{section ===/);
  });
});

// 回收站聚合入口已下线：与数据库、知识库各自就近的回收站重复。
// 删的是「聚合入口」，两个模块自己的回收站页面与侧边栏入口都不动——
// 这里锁住的是「不留无效引用」，以及「删聚合 ≠ 删模块回收站」。
describe("回收站聚合入口已下线（各模块自己的回收站保留）", () => {
  it("左二级不再有「回收站」分区，通用页也不再出现回收站字样", () => {
    expect(pageSrc).not.toContain('key: "trash"');
    expect(pageSrc).not.toContain("TrashSection");
    expect(renderPage()).not.toContain("回收站");
  });

  it("聚合入口组件文件已删除，页面不再 import 它", () => {
    expect(pageSrc).not.toContain("WorkspaceSettingsSections");
    expect(
      existsSync(new URL("./WorkspaceSettingsSections.tsx", import.meta.url)),
    ).toBe(false);
  });

  it("数据库与知识库各自的回收站路由仍在（删聚合入口 ≠ 删模块回收站）", () => {
    const app = read("../../App.tsx");
    expect(app).toContain("/base/:baseId/trash");
    expect(app).toContain("/kb/:kbId/trash");
  });
});

describe("上传限制上提到工作区设置（全局层）", () => {
  it("通用分区里能改上传限制", () => {
    const html = renderPage("/workspace/settings/general");
    expect(html).toContain("上传限制");
    expect(html).toContain("允许格式");
  });

  it("知识库设置页不再挂面板，只留说明 + 跳转，不留死角", () => {
    const kb = read("../kb/KbSettingsPage.tsx");
    expect(kb).not.toContain("UploadLimitsPanel");
    expect(kb).toContain("/workspace/settings/general");
    expect(kb).toContain("前往工作区设置修改");
  });
});

describe("左栏响应式：<1024 折叠，不横向溢出", () => {
  it("常驻左二级只在 ≥1024 挂载（lg:flex），窄屏改唤出条（lg:hidden）", () => {
    // v6 #1003：宽屏栏从 w-52 灰底改为恒 236、白底 bg-gx-nav2 的 L2 同款面板
    expect(pageSrc).toMatch(/className="hidden w-\[236px\][^"]*\blg:flex\b/);
    expect(pageSrc).toMatch(/className="[^"]*\blg:hidden\b/);
  });

  it("v6 #1003：宽/窄两栏的「返回」钮（navigate(-1)）已删除——设置中心无可靠上一级", () => {
    expect(pageSrc).not.toContain("navigate(-1)");
    expect(pageSrc).not.toContain("aria-label=\"返回\"");
    expect(pageSrc).not.toContain(">返回<");
  });

  it("外层与内容区都带 min-w-0，内容不被左栏压扁", () => {
    expect(pageSrc).toContain("flex h-full min-w-0 flex-col lg:flex-row");
    expect(pageSrc).toContain("min-w-0 flex-1 overflow-y-auto");
  });

  it("内容区内边距随断点收窄（窄屏不吃掉 64px 横向留白）", () => {
    expect(pageSrc).toContain("px-4 py-6 sm:px-6 lg:px-8 lg:py-8");
  });

  it("窄屏唤出条在 SSR 也渲染（靠断点类显隐，不靠 JS 媒体查询）", () => {
    const html = renderPage();
    expect(html).toContain('aria-controls="ws-section-list"');
    expect(html).toContain("切换分区");
    expect(html).toContain("lg:hidden");
    expect(html).toContain("lg:flex");
  });
});
