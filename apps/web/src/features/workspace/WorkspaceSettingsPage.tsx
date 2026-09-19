// M3/S8 工作区设置中心。左二级 + 右内容，仿 SettingsPage 布局；
// 安全/备份/embedding/MCP 不放假入口、不放"即将上线"占位，随对应里程碑自然增列。
//
// 分区口径纪律（本轮治理的核心，改这个文件时不要破坏）：
//   1. 右内容的渲染判定只认 effectiveSection，**绝不认 URL 原始 section**。
//      门控分区（search/mcp…）守卫回落后若仍按 section 判断，会与左栏的
//      effectiveSection 判定双双落空 → 右内容区整块空白（既不是通用也不是目标分区）。
//   2. effectiveSection 由 visibleSections 反查得出（单一真源）：
//      新增 gated 分区只要在 SECTIONS 上打 ownerOnly/enterpriseOnly 标记就自动受约束，
//      不需要再记得改第二处三元判断——这正是「点左侧右侧空白」的根因修复。
//   3. 可解析的 splat 集合同样由 SECTIONS 推导，未知 splat 一律落「通用」。
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon, type IconName } from "../../components/icons";
import { useIsWorkspaceOwner, useMyOrgActions } from "../contacts/contacts-hooks";
import { ContactsDirectory } from "../contacts/ContactsDirectory";
import PermPanel from "../authz/PermPanel";
import { canSeeAuthz } from "./lib/nav-gate";
import { useAuthzCapability } from "../authz/useAuthzCapability";
import { AssetsSection, TrashSection } from "./WorkspaceSettingsSections";
import { EmbeddingSearchPanel } from "../search/EmbeddingSearchPanel";
import { SearchCoveragePanel } from "../search/SearchCoveragePanel";
import { ReindexModal } from "../search/ReindexModal";
import { useReindex, isForbidden, isSearchNotEnabled, errorCode } from "../search/search-admin-hooks";
import { adminErrorMessage, SEARCH_NOT_ENABLED } from "../search/search-admin-copy";
import { PatListPanel } from "../settings/PatListPanel";
import { useEnterpriseOrgFlag } from "../settings/pat-hooks";
// 上传限制：本机浏览器生效、跨全部知识库，属全局设置 → 上提到工作区层（原挂知识库设置页）。
import { UploadLimitsPanel } from "../kb/UploadLimitsPanel";
import { toast } from "../../components/ui";

type Section = "general" | "contacts" | "authz" | "search" | "mcp" | "assets" | "trash";

const SECTIONS: {
  key: Section;
  label: string;
  icon: IconName;
  desc: string;
  ownerOnly?: boolean;
  /** M6 MCP 接入随 GX_ENTERPRISE_ORG 门控（off 即不挂载，fail-closed 隐入口）。 */
  enterpriseOnly?: boolean;
}[] = [
  { key: "general", label: "通用", icon: "settings", desc: "工作区设置中心" },
  // ownerOnly：分区涉及全组织成员/授权数据，沿用 SEARCH 分区既有的 owner 口径（见下 visibleSections），
  //   非 owner 连分区都不渲染——不做 disabled 假入口（P2-B3）。
  { key: "contacts", label: "通讯录", icon: "building", desc: "部门、成员与组织角色", ownerOnly: true },
  { key: "authz", label: "权限管理", icon: "shield", desc: "资源树授权与策略下发", ownerOnly: true },
  { key: "search", label: "语义检索", icon: "sparkles", desc: "云端语义检索与索引覆盖度", ownerOnly: true },
  { key: "mcp", label: "MCP 接入", icon: "keyRound", desc: "为 AI 客户端签发访问令牌", enterpriseOnly: true },
  { key: "assets", label: "资产", icon: "database", desc: "数据库与知识库入口" },
  { key: "trash", label: "回收站", icon: "trash", desc: "数据库与知识库回收站入口" },
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
    <div className={wrap ? "flex flex-wrap gap-1" : "flex flex-col"}>
      {sections.map((s) => {
        const on = active === s.key;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onPick(s.key)}
            aria-current={on ? "page" : undefined}
            title={s.desc}
            className={[
              "flex items-center gap-2 rounded-gx-lg text-gx-13 transition-colors",
              wrap ? "px-2.5 py-1.5" : "mx-2 px-2 py-1.5 text-left",
              // R-N-10：L2 选中态 = 白底卡片 + 圆角 8 + accent 600 字，**不用左侧色条**
              on ? "bg-white font-semibold text-gx-accent" : "text-gx-text-primary hover:bg-gx-row-hover",
            ].join(" ")}
          >
            <Icon
              name={s.icon}
              size={14}
              className={`shrink-0 ${on ? "text-gx-accent" : "opacity-80"}`}
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
  const reindex = useReindex();

  // 子页由 URL 驱动（/workspace/settings/<section>）：刷新/直访落到同一子页，链接可分享。
  // 无 splat（/workspace/settings）与未知 splat 一并落到「通用」。
  const section: Section = SECTION_KEYS.includes(splat ?? "") ? (splat as Section) : "general";
  const goSection = (s: Section) => navigate(`/workspace/settings/${s}`);

  // P2-B3：权限管理分区沿用 nav-gate 的 canSeeAuthz 口径（与 PermPanel 直访门控同源），
  // 探针未回来按不可见（fail-closed），避免先出分区再消失。
  const { actions, isLoading: actionsLoading } = useMyOrgActions();
  const { canManage } = useAuthzCapability();
  const canManageAuthz = !actionsLoading && canSeeAuthz(actions, canManage);

  const visibleSections = SECTIONS.filter(
    (s) =>
      (!s.ownerOnly || isOwner) &&
      (!s.enterpriseOnly || enterpriseOn) &&
      (s.key !== "authz" || canManageAuthz),
  );

  // 单一口径：分区不在 visibleSections 里（非 owner 直戳 search、非企业直戳 mcp、
  // 或任何未来新增的门控分区）一律回落「通用」，保证右内容永不空白。
  const effectiveSection: Section =
    visibleSections.some((s) => s.key === section) ? section : "general";
  // effectiveSection 由 visibleSections 反查得出，这里必定命中；兜底只为类型收窄。
  const currentSection = visibleSections.find((s) => s.key === effectiveSection) ?? SECTIONS[0]!;

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
            isSearchNotEnabled(e) ? SEARCH_NOT_ENABLED.toast : adminErrorMessage(errorCode(e)),
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
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label="返回"
            className="flex shrink-0 items-center rounded-gx-sm p-1.5 text-gx-text-tertiary hover:bg-gx-row-hover hover:text-gx-text-primary"
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <button
            type="button"
            onClick={() => setNavOpen((v) => !v)}
            aria-expanded={navOpen}
            aria-controls="ws-section-list"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-gx-lg px-2 py-1.5 text-left hover:bg-gx-row-hover"
          >
            <Icon name={currentSection.icon} size={14} className="shrink-0 text-gx-accent" />
            <span className="min-w-0 flex-1 truncate text-gx-13 font-medium text-gx-text-primary">
              {currentSection.label}
            </span>
            <span className="shrink-0 text-gx-11 text-gx-text-hint">切换分区</span>
            <Icon
              name={navOpen ? "chevronUp" : "chevronDown"}
              size={14}
              className="shrink-0 text-gx-text-tertiary"
            />
          </button>
        </div>
        {navOpen && (
          <div id="ws-section-list" className="border-t border-gx-separator px-3 py-2">
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

      {/* ≥1024：常驻左二级 */}
      <aside className="hidden w-52 shrink-0 flex-col border-r border-gx-separator bg-gx-bg py-3 lg:flex">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mx-2 mb-2 flex items-center gap-1.5 rounded-gx-sm px-2 py-1.5 text-gx-12 text-gx-text-tertiary hover:bg-gx-row-hover hover:text-gx-text-primary"
        >
          <Icon name="chevronLeft" size={14} />
          返回
        </button>
        <SectionList
          sections={visibleSections}
          active={effectiveSection}
          variant="vertical"
          onPick={goSection}
        />
      </aside>

      {/* 右内容 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {effectiveSection === "general" && (
            <div className="flex flex-col gap-2">
              <h2 className="text-gx-18 font-semibold text-gx-text-primary">工作区设置</h2>
              <p className="text-gx-13 text-gx-text-tertiary">
                管理组织通讯录与资产入口。更多工作区能力将随对应版本在此增列。
              </p>
              {/* P2-B3：通讯录分区已 ownerOnly，这张跳转卡片对非 owner 就是点了没反应的假入口，
                  与分区同口径渲染（非 owner 不出现）。 */}
              {isOwner && (
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => goSection("contacts")}
                    className="flex items-start gap-3 rounded-gx-lg border border-gx-separator p-4 text-left hover:bg-gx-row-hover"
                  >
                    <Icon name="building" size={18} className="mt-0.5 text-gx-accent" />
                    <span>
                      <span className="block text-gx-13 font-medium text-gx-text-primary">通讯录</span>
                      <span className="mt-0.5 block text-gx-12 text-gx-text-hint">部门、成员与组织角色</span>
                    </span>
                  </button>
                </div>
              )}

              {/* 上传限制（原挂知识库设置页）：本机浏览器生效、跨全部知识库 → 归全局层 */}
              <div className="mt-6 flex flex-col gap-2">
                <p className="text-gx-12 text-gx-text-tertiary">
                  对这台浏览器里的全部知识库生效，不属于单个知识库；已由「知识库设置」上提到此处统一管理。
                </p>
                <UploadLimitsPanel />
              </div>
            </div>
          )}

          {effectiveSection === "contacts" && (
            <div className="flex min-w-0 flex-col gap-3">
              <h2 className="text-gx-18 font-semibold text-gx-text-primary">通讯录</h2>
              <p className="text-gx-13 text-gx-text-tertiary">
                成员、部门与组织角色在此统一管理，改动即时生效。
              </p>
              <p className="text-gx-12 text-gx-text-hint">
                单个数据库 / 知识库的成员与角色是另一层切面，请到各自资产的「设置」页管理。
              </p>
              {/* P2-B2：不再是「说明 + 跳转按钮」，直接内嵌 ContactsDirectory
                  （与 /workspace/contacts 同一个组件），口径只有一处。 */}
              <div className="h-[560px] overflow-hidden rounded-gx-lg border border-gx-separator">
                <ContactsDirectory />
              </div>
            </div>
          )}

          {effectiveSection === "authz" && (
            <div className="flex min-w-0 flex-col gap-3">
              <h2 className="text-gx-18 font-semibold text-gx-text-primary">权限管理</h2>
              <p className="text-gx-13 text-gx-text-tertiary">
                按资源树查看与下发授权策略；这里的操作与「权限管理」页完全同源。
              </p>
              {/* PermPanel 自带 canSeeAuthz 门控（无能力出无权限态），
                  这里再叠一层分区级判定：非 owner / 无能力时连分区都不渲染（P2-B3）。 */}
              <div className="h-[560px] overflow-hidden rounded-gx-lg border border-gx-separator">
                <PermPanel embedded />
              </div>
            </div>
          )}

          {effectiveSection === "search" && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-gx-18 font-semibold text-gx-text-primary">语义检索</h2>
                <p className="mt-1 text-gx-13 text-gx-text-tertiary">配置云端语义检索，并查看索引覆盖与健康状态。</p>
              </div>
              <EmbeddingSearchPanel onReindex={openReindex} />
              <div>
                <h3 className="mb-2 text-gx-14 font-semibold text-gx-text-primary">索引覆盖度</h3>
                <SearchCoveragePanel onReindex={openReindex} />
              </div>
            </div>
          )}

          {effectiveSection === "mcp" && (
            <div className="flex flex-col gap-6">
              <div>
                <h2 className="text-gx-18 font-semibold text-gx-text-primary">MCP 接入</h2>
                <p className="mt-1 text-gx-13 text-gx-text-tertiary">
                  为 AI 客户端签发访问令牌，按最小权限原则控制其可读写的范围。
                </p>
              </div>
              <PatListPanel />
            </div>
          )}

          {effectiveSection === "assets" && (
            <div className="flex flex-col gap-3">
              <h2 className="mb-1 text-gx-18 font-semibold text-gx-text-primary">资产</h2>
              <AssetsSection />
            </div>
          )}

          {effectiveSection === "trash" && (
            <div className="flex flex-col gap-3">
              <h2 className="text-gx-18 font-semibold text-gx-text-primary">回收站</h2>
              <p className="text-gx-13 text-gx-text-tertiary">
                数据库与知识库的回收站分别从这里进入，恢复或彻底删除都在各自的回收站里完成。
              </p>
              <TrashSection />
            </div>
          )}
        </div>
      </div>

      {/* 覆盖度面板/语义面板共用的重建确认弹窗（owner 才挂载到这里） */}
      {isOwner && (
        <ReindexModal open={reindexOpen} busy={reindex.isPending} onClose={() => setReindexOpen(false)} onConfirm={fireReindex} />
      )}
    </div>
  );
}
