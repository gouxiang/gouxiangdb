// M3/S8 工作区设置中心（裁决 7：首版仅三个真实条目——通讯录 / 导航编排 / 资产）。
// 左二级 + 右内容，仿 SettingsPage 布局；安全/备份/embedding/MCP 不放假入口、
// 不放"即将上线"占位，随对应里程碑自然增列。
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useBases } from "../../api/hooks";
import { useKbList } from "../kb/kb-hooks";
import { Spinner } from "../../components/ui";
import { Icon, type IconName } from "../../components/icons";
import { useMyOrgActions, useIsWorkspaceOwner } from "../contacts/contacts-hooks";
import { NavComposer } from "./NavComposer";
import { EmbeddingSearchPanel } from "../search/EmbeddingSearchPanel";
import { SearchCoveragePanel } from "../search/SearchCoveragePanel";
import { ReindexModal } from "../search/ReindexModal";
import { useReindex, isForbidden, isSearchNotEnabled, errorCode } from "../search/search-admin-hooks";
import { adminErrorMessage, SEARCH_NOT_ENABLED } from "../search/search-admin-copy";
import { PatListPanel } from "../settings/PatListPanel";
import { useEnterpriseOrgFlag } from "../settings/pat-hooks";
import { toast } from "../../components/ui";

type Section = "general" | "contacts" | "nav" | "search" | "mcp" | "assets";

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
  { key: "contacts", label: "通讯录", icon: "building", desc: "部门、成员与组织角色" },
  { key: "nav", label: "导航编排", icon: "sitemap", desc: "一级导航与分组管理" },
  { key: "search", label: "语义检索", icon: "sparkles", desc: "云端语义检索与索引覆盖度", ownerOnly: true },
  { key: "mcp", label: "MCP 接入", icon: "keyRound", desc: "为 AI 客户端签发访问令牌", enterpriseOnly: true },
  { key: "assets", label: "资产", icon: "database", desc: "数据库与知识库入口" },
];

function AssetsSection() {
  const navigate = useNavigate();
  const { data: bases, isLoading: loadingBases } = useBases();
  const { data: kbs, isLoading: loadingKb } = useKbList();
  const stableBases = useMemo(() => bases ?? [], [bases]);
  const stableKbs = useMemo(() => kbs ?? [], [kbs]);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-2 text-gx-13 font-medium text-gx-text-primary">智能数据库</h3>
        {loadingBases ? (
          <Spinner size={16} />
        ) : stableBases.length === 0 ? (
          <p className="text-gx-12 text-gx-text-hint">暂无数据库</p>
        ) : (
          <ul className="flex flex-col divide-y divide-gx-separator rounded-gx-lg border border-gx-separator">
            {stableBases.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/base/${b.id}/settings`)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-gx-13 hover:bg-gx-row-hover"
                >
                  <Icon name="database" size={15} className="shrink-0 text-gx-text-tertiary" />
                  <span className="flex-1 truncate text-gx-text-primary">{b.name}</span>
                  <Icon name="chevronRight" size={14} className="text-gx-text-hint" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-gx-13 font-medium text-gx-text-primary">知识库</h3>
        {loadingKb ? (
          <Spinner size={16} />
        ) : stableKbs.length === 0 ? (
          <p className="text-gx-12 text-gx-text-hint">暂无知识库</p>
        ) : (
          <ul className="flex flex-col divide-y divide-gx-separator rounded-gx-lg border border-gx-separator">
            {stableKbs.map((k) => (
              <li key={k.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/kb/${k.id}/settings`)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-gx-13 hover:bg-gx-row-hover"
                >
                  <Icon name="book" size={15} className="shrink-0 text-gx-text-tertiary" />
                  <span className="flex-1 truncate text-gx-text-primary">{k.name}</span>
                  <Icon name="chevronRight" size={14} className="text-gx-text-hint" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function WorkspaceSettingsPage() {
  const navigate = useNavigate();
  const { "*": splat } = useParams();
  const { actions } = useMyOrgActions();
  const canManageMenu = actions.has("manage_menu");
  // M5 检索管理面仅工作区所有者可见；加载未完成先按非 owner 处理（不闪现面板）。
  const { isOwner } = useIsWorkspaceOwner();
  // M6 MCP 接入随企业组织门控；loading/探测失败/非 true 一律 false（fail-closed）。
  const enterpriseOn = useEnterpriseOrgFlag();
  const [reindexOpen, setReindexOpen] = useState(false);
  const reindex = useReindex();

  // 子页由 URL 驱动（/workspace/settings/<section>）：刷新/直访落到同一子页，链接可分享。
  // 无 splat（/workspace/settings）与未知 splat 一并落到「通用」，旧的 /settings/nav 仍可用。
  const section: Section =
    splat === "contacts" || splat === "nav" || splat === "search" || splat === "mcp" || splat === "assets"
      ? splat
      : "general";
  const goSection = (s: Section) => navigate(`/workspace/settings/${s}`);

  const visibleSections = SECTIONS.filter(
    (s) => (!s.ownerOnly || isOwner) && (!s.enterpriseOnly || enterpriseOn),
  );

  // 非 owner 直戳 search / 非企业环境直戳 mcp 时回落通用，保证不渲染后台面板（403 在 hooks 静默）。
  const effectiveSection: Section =
    (section === "search" && !isOwner) || (section === "mcp" && !enterpriseOn) ? "general" : section;

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
    <div className="flex h-full">
      {/* 左二级 */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-gx-separator bg-gx-bg py-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="mx-2 mb-2 flex items-center gap-1.5 rounded-gx-sm px-2 py-1.5 text-gx-12 text-gx-text-tertiary hover:bg-gx-row-hover hover:text-gx-text-primary"
        >
          <Icon name="chevronLeft" size={14} />
          返回
        </button>
        {visibleSections.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => goSection(s.key)}
            className={[
              // R-N-10：L2 选中态 = 白底卡片 + 圆角 8 + accent 600 字，**不用左侧色条**
              "mx-2 flex items-center gap-2 rounded-gx-lg px-2 py-1.5 text-left text-gx-13 transition-colors",
              effectiveSection === s.key
                ? "bg-white font-semibold text-gx-accent"
                : "text-gx-text-primary hover:bg-gx-row-hover",
            ].join(" ")}
          >
            <Icon
              name={s.icon}
              size={14}
              className={`shrink-0 ${effectiveSection === s.key ? "text-gx-accent" : "opacity-80"}`}
            />
            {s.label}
          </button>
        ))}
      </aside>

      {/* 右内容 */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          {section === "general" && (
            <div className="flex flex-col gap-2">
              <h2 className="text-gx-18 font-semibold text-gx-text-primary">工作区设置</h2>
              <p className="text-gx-13 text-gx-text-tertiary">
                管理组织通讯录、导航编排与资产入口。更多工作区能力将随对应版本在此增列。
              </p>
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
                <button
                  type="button"
                  onClick={() => goSection("nav")}
                  className="flex items-start gap-3 rounded-gx-lg border border-gx-separator p-4 text-left hover:bg-gx-row-hover"
                >
                  <Icon name="sitemap" size={18} className="mt-0.5 text-gx-accent" />
                  <span>
                    <span className="block text-gx-13 font-medium text-gx-text-primary">导航编排</span>
                    <span className="mt-0.5 block text-gx-12 text-gx-text-hint">一级导航、快捷项与分组</span>
                  </span>
                </button>
              </div>
            </div>
          )}

          {section === "contacts" && (
            <div className="flex flex-col gap-3">
              <h2 className="text-gx-18 font-semibold text-gx-text-primary">通讯录</h2>
              <p className="text-gx-13 text-gx-text-tertiary">组织部门、成员与角色管理在通讯录工作区。</p>
              <button
                type="button"
                onClick={() => navigate("/workspace/contacts")}
                className="inline-flex w-fit items-center gap-2 rounded-gx-lg bg-gx-accent px-3 py-1.5 text-gx-13 font-medium text-white hover:brightness-95"
              >
                <Icon name="building" size={14} />
                打开通讯录
              </button>
            </div>
          )}

          {section === "nav" &&
            (canManageMenu ? (
              <NavComposer />
            ) : (
              <div className="flex flex-col gap-2">
                <h2 className="text-gx-18 font-semibold text-gx-text-primary">导航编排</h2>
                <p className="text-gx-13 text-gx-text-tertiary">你没有「导航编排」权限，请联系工作区所有者或具备 manage_menu 动作的角色。</p>
              </div>
            ))}

          {effectiveSection === "search" && isOwner && (
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

          {effectiveSection === "mcp" && enterpriseOn && (
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

          {section === "assets" && (
            <div className="flex flex-col gap-3">
              <h2 className="mb-1 text-gx-18 font-semibold text-gx-text-primary">资产</h2>
              <AssetsSection />
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
