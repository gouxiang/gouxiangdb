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
import { readFileSync } from "node:fs";

let enterpriseOn = false;
let isOwner = false;
let manageMenu = false;

vi.mock("../contacts/contacts-hooks", () => ({
  useMyOrgActions: () => ({ actions: new Set(manageMenu ? ["manage_menu"] : []), isLoading: false }),
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

vi.mock("../contacts/ContactsDirectory", () => ({
  ContactsDirectory: () => <div data-contacts-directory="1" />,
}));
// 分区门控要读 useAuthzCapability（权限分区），这里给确定值，不发请求。
vi.mock("../authz/useAuthzCapability", () => ({
  useAuthzCapability: () => ({ canManage: true }),
}));
// PermPanel 内嵌后依赖自己的 useState 子树，本组用例只关心分区渲染位置，桩掉即可。
vi.mock("../authz/PermPanel", () => ({
  default: () => <div data-perm-panel-embedded="1" />,
}));

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
const GENERAL = "管理组织通讯录与资产入口";

function renderPage(location = "/workspace/settings"): string {
  // 资产/回收站/导航子页内部用 useQuery（SSR 不跑 queryFn），需要 QueryClient 上下文。
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    <QueryClientProvider client={qc}>
      <StaticRouter location={location}>
        <Routes>
          <Route path="/workspace/settings/*" element={<WorkspaceSettingsPage />} />
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
    expect(html).not.toContain("数据库回收站");
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
    expect(renderPage("/workspace/settings/search")).toContain("配置云端语义检索");
  });

  it("企业环境直戳 /mcp 仍然进得去", () => {
    enterpriseOn = true;
    expect(renderPage("/workspace/settings/mcp")).toContain("为 AI 客户端签发访问令牌");
  });

  it("非 gated 分区直戳不受影响（assets / trash）", () => {
    expect(renderPage("/workspace/settings/assets")).toContain("智能数据库");
    expect(renderPage("/workspace/settings/trash")).toContain("数据库回收站");
  });

  // P2-B3：通讯录分区改为 ownerOnly（内嵌真实成员数据，非 owner 不该见到）。
  it("非 owner 直戳 /contacts → 回落通用，且右内容不含通讯录列表", () => {
    isOwner = false;
    const html = renderPage("/workspace/settings/contacts");
    expect(html).toContain(GENERAL);
    expect(html).not.toContain("data-contacts-directory");
  });

  it("owner 直戳 /contacts 仍然进得去（守卫没有反向误杀）", () => {
    isOwner = true;
    expect(renderPage("/workspace/settings/contacts")).toContain("data-contacts-directory");
  });

  it("effectiveSection 由 visibleSections 反查得出（单一真源）", () => {
    expect(pageSrc).toContain("visibleSections.some((s) => s.key === section)");
    expect(pageSrc).not.toContain('section === "search" && !isOwner');
  });

  it("右内容渲染判定一律走 effectiveSection，不允许残留 `{section ===`", () => {
    expect(pageSrc).not.toMatch(/\{section ===/);
  });
});

describe("回收站聚合入口", () => {
  it("/trash 同时给出数据库与知识库回收站入口", () => {
    const html = renderPage("/workspace/settings/trash");
    expect(html).toContain("数据库回收站");
    expect(html).toContain("知识库回收站");
  });

  it("左二级出现「回收站」分区（且是新增的第 7 个分区，不动原有顺序）", () => {
    expect(pageSrc).toContain('key: "trash", label: "回收站"');
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
    expect(pageSrc).toMatch(/className="hidden w-52[^"]*\blg:flex\b/);
    expect(pageSrc).toMatch(/className="[^"]*\blg:hidden\b/);
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
