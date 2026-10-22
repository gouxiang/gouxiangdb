// M3/S8 工作区设置中心。左二级 + 右内容，仿 SettingsPage 布局；
// 安全/备份/embedding/MCP 不放假入口、不放"即将上线"占位，随对应里程碑自然增列。
//
// 分区口径纪律（本轮治理的核心，改这个文件时不要破坏）：
//   1. 右内容的渲染判定只认 effectiveSection，**绝不认 URL 原始 section**。
//      门控分区守卫回落后若仍按 section 判断，会与左栏的 effectiveSection 判定双双落空
//      → 右内容区整块空白（既不是通用也不是目标分区）。
//   2. effectiveSection 由 visibleSections 反查得出（单一真源）：
//      新增 gated 分区只要在 SECTIONS 上打 ownerOnly/manageOnly/enterpriseOnly 标记就自动受约束，
//      不需要再记得改第二处三元判断——这正是「点左侧右侧空白」的根因修复。
//   3. 可解析的 splat 集合同样由 SECTIONS 推导，未知 splat 一律落「通用」。
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon, type IconName } from "../../components/icons";
import {
  useIsWorkspaceOwner,
  useMyOrgActions,
} from "../contacts/contacts-hooks";
import { canSeeAuthz, canSeeWorkspaceSettings } from "./lib/nav-gate";
import { useAuthzCapability } from "../authz/useAuthzCapability";
import { RolePermissionSection } from "../settings/role-permission/RolePermissionSection";
import { EmbeddingSearchPanel } from "../search/EmbeddingSearchPanel";
import { SearchCoveragePanel } from "../search/SearchCoveragePanel";
import { ReindexModal } from "../search/ReindexModal";
import {
  useReindex,
  isForbidden,
  isSearchNotEnabled,
  errorCode,
} from "../search/search-admin-hooks";
import {
  adminErrorMessage,
  SEARCH_NOT_ENABLED,
} from "../search/search-admin-copy";
import { PatListPanel } from "../settings/PatListPanel";
import { useEnterpriseOrgFlag } from "../settings/pat-hooks";
// 上传限制：本机浏览器生效、跨全部知识库，属全局设置 → 上提到工作区层（原挂知识库设置页）。
import { UploadLimitsPanel } from "../kb/UploadLimitsPanel";
import { UpdatePanel } from "../update/UpdatePanel";
import { BrandingSettingsPanel } from "../branding/BrandingSettingsPanel";
import { toast } from "../../components/ui";

// 「通讯录」分区已移除：一级导航底部已有通讯录入口（/workspace/contacts），设置里不再重复。
// 「资产」分区已移除：单个库/知识库的深度设置改由一级导航条目行尾的「…」菜单进入。
// 「回收站」分区已移除：与数据库（/base/:id/trash）、知识库（/kb/:id/trash）各自的回收站重复，
//   聚合入口不再列；两个模块自己的回收站页面与其侧边栏就近入口保留不动。
type Section = "general" | "branding" | "authz" | "search" | "mcp" | "update";

const SECTIONS: {
  key: Section;
  label: string;
  icon: IconName;
  desc: string;
  ownerOnly?: boolean;
  /**
   * 管理动作口径（与 lib/nav-gate.canSeeWorkspaceSettings 同源）：持任一 manage_* 组织动作即见，
   * owner 亦见。用于「需要进得去配置，但不必是所有者」的分区（语义检索：非 owner 管理员也要能开关总门）。
   */
  manageOnly?: boolean;
  /** M6 MCP 接入随 GX_ENTERPRISE_ORG 门控（off 即不挂载，fail-closed 隐入口）。 */
  enterpriseOnly?: boolean;
}[] = [
  { key: "general", label: "通用", icon: "settings", desc: "工作区设置中心" },
  // ownerOnly：品牌外观（产品名/版权/登录广告图）后端只认 super_admin/admin/legacy owner，
  //   不认 manage_* 动作位；非 owner 连分区都不渲染，直访 URL 回落「通用」。
  {
    key: "branding",
    label: "品牌外观",
    icon: "palette",
    desc: "产品名、版权信息与登录页广告图",
    ownerOnly: true,
  },
  // ownerOnly：分区涉及全组织成员/授权数据，沿用 SEARCH 分区既有的 owner 口径（见下 visibleSections），
  //   非 owner 连分区都不渲染——不做 disabled 假入口（P2-B3）。
  {
    key: "authz",
    label: "权限管理",
    icon: "shield",
    desc: "资源树授权与策略下发",
    ownerOnly: true,
  },
  // manageOnly：语义检索是「开关型」配置——非 owner 的管理员（持任一 manage_* 组织动作）也要能
  //   开/关总门，ownerOnly 会把他们一起挡在外面。口径与 canSeeWorkspaceSettings 同一处，owner 恒可见。
  {
    key: "search",
    label: "语义检索",
    icon: "sparkles",
    desc: "云端语义检索与索引覆盖度",
    manageOnly: true,
  },
  {
    key: "mcp",
    label: "MCP 接入",
    icon: "keyRound",
    desc: "为 AI 客户端签发访问令牌",
    enterpriseOnly: true,
  },
  // ownerOnly：应用版本更新只由工作区所有者操作（下载票据也只签给 owner）；
  // 总开关默认 on，GX_UPDATE_ENABLED=off 时面板检查得 404 自行隐藏（见 UpdatePanel onUnregistered）。
  {
    key: "update",
    label: "系统更新",
    icon: "download",
    desc: "检查并下载新版本安装包",
    ownerOnly: true,
  },
];

const SECTION_KEYS: string[] = SECTIONS.map((s) => s.key);

/**
 * 分区列表。桌面竖排常驻左栏；<1024 折叠成唤出条时改横向 wrap，避免竖排吃掉内容高度。
 * 两种布局都在 DOM 里（由 Tailwind lg: 断点类控制显隐），不靠 JS 媒体查询，SSR/首屏无跳变。
 */
function SectionList({
  sections,
  active,
  variant,
  onPick,
}: {
  sections: typeof SECTIONS;
  active: Section;
  variant: "vertical" | "wrap";
  onPick: (key: Section) => void;
}) {
  const wrap = variant === "wrap";
  return (
    <div className={wrap ? "flex flex-wrap gap-1" : "flex flex-col gap-0.5 px-2"}>
      {sections.map((s) => {
        const on = active === s.key;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onPick(s.key)}
            aria-current={on ? "page" : undefined}
            title={s.desc}
            className={
              wrap
                ? [
                    "flex items-center gap-2 rounded-gx-lg px-2.5 py-1.5 text-gx-13 transition-colors",
                    on
                      ? "bg-white font-semibold text-gx-accent"
                      : "text-gx-text-primary hover:bg-gx-row-hover",
                  ].join(" ")
                : // v6 #1003：宽屏竖排对齐底板 L2 行（.l2-item/.l2-row.is-active）——
                  // 整行 h-8、r8，选中＝整行 brand-soft 底 + brand-ink/600 字（不再是白卡片）。
                  [
                    "flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left text-gx-13 transition-colors",
                    on
                      ? "bg-gx-accent-bg font-semibold text-gx-accent-hover"
                      : "text-gx-text-secondary hover:bg-gx-row-hover hover:text-gx-text-primary",
                  ].join(" ")
            }
          >
            <Icon
              name={s.icon}
              size={14}
              className={`shrink-0 ${on ? "text-gx-accent-hover" : "opacity-80"}`}
            />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

export function WorkspaceSettingsPage() {
  const navigate = useNavigate();
  const { "*": splat } = useParams();
  const { isOwner } = useIsWorkspaceOwner();
  // M6 MCP 接入随企业组织门控；loading/探测失败/非 true 一律 false（fail-closed）。
  const enterpriseOn = useEnterpriseOrgFlag();
  const [reindexOpen, setReindexOpen] = useState(false);
  // <1024 时左二级折叠成唤出条；仅窄屏可见，展开选中后自动收起。
  const [navOpen, setNavOpen] = useState(false);
  // 系统更新总开关 off（status 404）时隐藏分区；默认 on 故初始 false（挂载不发请求，无探测闪烁）。
  const [updateUnregistered, setUpdateUnregistered] = useState(false);
  const reindex = useReindex();

  // 子页由 URL 驱动（/workspace/settings/<section>）：刷新/直访落到同一子页，链接可分享。
  // 无 splat（/workspace/settings）与未知 splat 一并落到「通用」。
  const section: Section = SECTION_KEYS.includes(splat ?? "")
    ? (splat as Section)
    : "general";
  const goSection = (s: Section) => navigate(`/workspace/settings/${s}`);

  // P2-B3：权限管理分区沿用 nav-gate 的 canSeeAuthz 口径（与 PermPanel 直访门控同源），
  // 探针未回来按不可见（fail-closed），避免先出分区再消失。
  const { actions, isLoading: actionsLoading } = useMyOrgActions();
  const { canManage } = useAuthzCapability();
  const canManageAuthz = !actionsLoading && canSeeAuthz(actions, canManage);
  // 语义检索分区：持任一 manage_* 组织动作即可见（owner 亦可见）；探针未回来按不可见（fail-closed）。
  const canSeeSearch =
    isOwner || (!actionsLoading && canSeeWorkspaceSettings(actions));

  const visibleSections = SECTIONS.filter(
    (s) =>
      (!s.ownerOnly || isOwner) &&
      (!s.manageOnly || canSeeSearch) &&
      (!s.enterpriseOnly || enterpriseOn) &&
      (s.key !== "authz" || canManageAuthz) &&
      (s.key !== "update" || !updateUnregistered),
  );

  // 单一口径：分区不在 visibleSections 里（非 owner 直戳 search、非企业直戳 mcp、
  // 或任何未来新增的门控分区）一律回落「通用」，保证右内容永不空白。
  const effectiveSection: Section = visibleSections.some(
    (s) => s.key === section,
  )
    ? section
    : "general";
  // effectiveSection 由 visibleSections 反查得出，这里必定命中；兜底只为类型收窄。
  const currentSection =
    visibleSections.find((s) => s.key === effectiveSection) ?? SECTIONS[0]!;

  const openReindex = () => setReindexOpen(true);
  const fireReindex = (body: Parameters<typeof reindex.mutate>[0]) =>
    reindex.mutate(body, {
      onSuccess: () => {
        setReindexOpen(false);
        toast("已开始在后台重建索引", "success");
      },
      onError: (e) => {
        // 子面未启用（404 NOT_FOUND）明说"没启用"；越权静默；其余给中性文案。
        if (!isForbidden(e)) {
          toast(
            isSearchNotEnabled(e)
              ? SEARCH_NOT_ENABLED.toast
              : adminErrorMessage(errorCode(e)),
            "error",
          );
        }
        setReindexOpen(false);
      },
    });

  return (
    <div className="flex h-full min-w-0 flex-col lg:flex-row">
      {/* <1024：左栏折叠成一条唤出条，不再横向硬占 208px（内容区不被压扁） */}
      <div className="shrink-0 border-b border-gx-separator bg-gx-bg lg:hidden">
        <div className="flex items-center gap-1.5 px-3 py-2">
          {/* v6 #1003：原顶条「返回」钮已删除——设置中心是常驻分区，无可靠上一级，
              返回无意义。仅保留当前分区下拉切换。 */}
          <button
            type="button"
            onClick={() => setNavOpen((v) => !v)}
            aria-expanded={navOpen}
            aria-controls="ws-section-list"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-gx-lg px-2 py-1.5 text-left hover:bg-gx-row-hover"
          >
            <Icon
              name={currentSection.icon}
              size={14}
              className="shrink-0 text-gx-accent"
            />
            <span className="min-w-0 flex-1 truncate text-gx-13 font-medium text-gx-text-primary">
              {currentSection.label}
            </span>
            <span className="shrink-0 text-gx-11 text-gx-text-hint">
              切换分区
            </span>
            <Icon
              name={navOpen ? "chevronUp" : "chevronDown"}
              size={14}
              className="shrink-0 text-gx-text-tertiary"
            />
          </button>
        </div>
        {navOpen && (
          <div
            id="ws-section-list"
            className="border-t border-gx-separator px-3 py-2"
          >
            <SectionList
              sections={visibleSections}
              active={effectiveSection}
              variant="wrap"
              onPick={(k) => {
                goSection(k);
                setNavOpen(false);
              }}
            />
          </div>
        )}
      </div>

      {/* ≥1024：常驻左二级。v6 #1003：对齐数据表 L2——恒 236 宽、白底 bg-gx-nav2、
          56px 头区与发丝线（与 L2 面板头同几何）；原顶栏「返回」钮已删除。 */}
      <aside className="hidden w-[236px] shrink-0 flex-col border-r border-gx-hairline bg-gx-nav2 lg:flex">
        <div className="flex h-[56px] shrink-0 items-center gap-[7px] border-b border-gx-hairline pl-3 pr-2">
          <span className="gx-l2-ico">
            <Icon name="settings" size={14} />
          </span>
          <span className="text-gx-13 font-semibold text-gx-text-primary">工作区设置</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          <SectionList
            sections={visibleSections}
            active={effectiveSection}
            variant="vertical"
            onPick={goSection}
          />
        </div>
      </aside>

      {/* 右内容 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {/* 权限管理是左右两栏（角色列表 + 该角色权限），768px 会把右栏压到 480px 内挤成一团，
            单独放宽到 1024px；其余小节维持原来的 768px 阅读宽度。 */}
        <div
          className={`mx-auto px-4 py-6 sm:px-6 lg:px-8 lg:py-8 ${
            effectiveSection === "authz" ? "max-w-5xl" : "max-w-3xl"
          }`}
        >
          {effectiveSection === "general" && (
            <div className="flex flex-col gap-2">
              <h2 className="text-gx-18 font-semibold text-gx-text-primary">
                工作区设置
              </h2>
              <p className="text-gx-13 text-gx-text-tertiary">
                权限与语义检索都在这里配置。单个数据库或知识库的设置，请在一级导航该条目行尾的「…」菜单里进入。
              </p>

              {/* 上传限制（原挂知识库设置页）：本机浏览器生效、跨全部知识库 → 归全局层 */}
              <div className="mt-6 flex flex-col gap-2">
                <p className="text-gx-12 text-gx-text-tertiary">
                  对这台浏览器里的全部知识库生效，不属于单个知识库；已由「知识库设置」上提到此处统一管理。
                </p>
                <UploadLimitsPanel />
              </div>
            </div>
          )}

          {/* 品牌外观：产品名/版权/登录广告图，仅 ownerOnly 分区可见（非 owner 已回落通用）。 */}
          {effectiveSection === "branding" && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-gx-18 font-semibold text-gx-text-primary">
                  品牌外观
                </h2>
                <p className="mt-1 text-gx-13 text-gx-text-tertiary">
                  自定义全站产品名、版权信息与登录页广告图；保存后对所有用户立即生效。
                </p>
              </div>
              <BrandingSettingsPanel />
            </div>
          )}

          {/* 权限管理：全站唯一入口——角色列表 + 该角色的通讯录权限与库权限。 */}
          {effectiveSection === "authz" && <RolePermissionSection />}

          {effectiveSection === "search" && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-gx-18 font-semibold text-gx-text-primary">
                  语义检索
                </h2>
                <p className="mt-1 text-gx-13 text-gx-text-tertiary">
                  配置云端语义检索，并查看索引覆盖与健康状态。
                </p>
              </div>
              <EmbeddingSearchPanel onReindex={openReindex} />
              <div>
                <h3 className="mb-2 text-gx-14 font-semibold text-gx-text-primary">
                  索引覆盖度
                </h3>
                <SearchCoveragePanel onReindex={openReindex} />
              </div>
            </div>
          )}

          {effectiveSection === "mcp" && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-gx-18 font-semibold text-gx-text-primary">
                  MCP 接入
                </h2>
                <p className="mt-1 text-gx-13 text-gx-text-tertiary">
                  为 AI 客户端签发访问令牌，按最小权限原则控制其可读写的范围。
                </p>
              </div>
              <PatListPanel />
            </div>
          )}

          {effectiveSection === "update" && (
            <UpdatePanel onUnregistered={() => setUpdateUnregistered(true)} />
          )}
        </div>
      </div>

      {/* 覆盖度面板/语义面板共用的重建确认弹窗（与语义检索分区同口径挂载） */}
      {canSeeSearch && (
        <ReindexModal
          open={reindexOpen}
          busy={reindex.isPending}
          onClose={() => setReindexOpen(false)}
          onConfirm={fireReindex}
        />
      )}
    </div>
  );
}
