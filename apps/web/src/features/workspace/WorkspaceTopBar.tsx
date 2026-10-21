// M3/S8 新工作区外壳顶栏（v6 S3 按底板 .topbar 重做，shared.css 186-225）：
//   左：面包屑 .crumb（替代品牌钮——品牌已在 rail logo，顶栏不再放产品名/数据库图标）
//   中：命令条 .cmd（全局搜索，提权现有 SearchDialog，⌘K 由 Shell 绑定）
//   右：同步中心（副本启用时）/ 帮助 / 竖分隔线 / 个人中心 .who
// 不做通知铃：产品没有通知功能，底板有铃但 SCOPE 明确不放假入口。
// 视觉字面值全部收口 index.css 的 .gx-* 类，本组件零 hex。
import { useState } from "react";
import { Link, useLocation, useMatch } from "react-router-dom";
import { Icon } from "../../components/icons";
import { useAuthStore } from "../../store/auth";
import { AVATAR_PALETTE } from "@gx/design-tokens";
import { PersonalCenterDrawer } from "../settings/PersonalCenterDrawer";
import { useSyncStore } from "../../store/sync";
import { useTables } from "../../api/hooks";
import { useKbDocs } from "../kb/kb-hooks";
import { deriveCrumb } from "./lib/route-crumb";

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

export function WorkspaceTopBar({
  onOpenSearch,
  /** 当前库名（壳层 activeContainer.name；工作区级路由/未就绪时为 null，面包屑按路由自洽）。 */
  containerName = null,
  containerKind = null,
}: {
  onOpenSearch: () => void;
  containerName?: string | null;
  containerKind?: "base" | "kb" | null;
}) {
  const user = useAuthStore((s) => s.user);
  // 离线同步中心入口：仅「桌面壳 + 副本功能已确认启用」时 store.enabled=true；浏览器/非副本
  // 恒 false（useSyncStatus 未挂载，enabled 永不翻真），按钮不渲染。
  const syncEnabled = useSyncStore((s) => s.enabled);
  const syncBadge = useSyncStore(
    (s) => s.report.conflictCount + s.report.quarantinedCount + s.report.pendingOutbox,
  );
  const syncActive = useSyncStore((s) => s.phase === "syncing");
  const openSyncCenter = useSyncStore((s) => s.openCenter);
  const [personalCenterOpen, setPersonalCenterOpen] = useState(false);

  // 布局路由内 useParams 取不到参数（同 Shell/SecondaryNav 口径），一律 useMatch。
  const location = useLocation();
  const tableMatch = useMatch("/base/:baseId/table/:tableId/*");
  const docMatch = useMatch("/kb/:kbId/doc/:docId");
  const canvasMatch = useMatch("/kb/:kbId/canvas/:docId");
  const docRoute = docMatch ?? canvasMatch;

  // 仅在确有表/文档上下文时取数：hook 不能条件调用，靠「参数置空 + hook 内 enabled 门控」
  // （useTables enabledOf(baseId)、useKbDocs enabled:!!kbId），与 SecondaryNav 同 queryKey 缓存复用。
  const tablesQ = useTables(tableMatch ? (tableMatch.params.baseId ?? null) : null);
  const docsQ = useKbDocs(docRoute?.params.kbId, docRoute ? "all" : undefined);

  const tableId = tableMatch?.params.tableId ?? null;
  const docId = docRoute?.params.docId ?? null;
  const tableName = tablesQ.data?.find((t) => t.id === tableId)?.name ?? null;
  const docTitle = docsQ.data?.find((d) => d.id === docId)?.title ?? null;

  const crumbs = deriveCrumb({
    pathname: location.pathname,
    baseName: containerKind === "base" ? containerName : null,
    kbName: containerKind === "kb" ? containerName : null,
    tableName,
    docTitle,
  });

  const who = user?.displayName ?? user?.email ?? "";

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-gx-hairline bg-gx-surface px-5">
      {/* 左：面包屑（零段不渲染 nav；单段按底板 c2 14/600；两段 c1 + 斜杠 + c2）。 */}
      {crumbs.length > 0 && (
        <nav className="gx-crumb" aria-label="面包屑">
          {crumbs.length === 1 ? (
            <span className="gx-crumb-c2">{crumbs[0]!.label}</span>
          ) : (
            <>
              {crumbs[0]!.to ? (
                <Link className="gx-crumb-c1" to={crumbs[0]!.to} title={`返回${crumbs[0]!.label}`}>
                  {crumbs[0]!.label}
                </Link>
              ) : (
                <span className="gx-crumb-c1">{crumbs[0]!.label}</span>
              )}
              <span className="gx-crumb-sep" aria-hidden>/</span>
              <span className="gx-crumb-c2">{crumbs[crumbs.length - 1]!.label}</span>
            </>
          )}
        </nav>
      )}

      {/*
        中：命令条（底板 .cmd）。⌘K 由 Shell 绑定，此处点击同样打开 SearchDialog。
        R-D-33（<768）：折叠为 32×32 图标按钮（仅图标，ph/kbd 隐藏）；md 起按底板展开
        （flex 0 1 400 / min 160 / max 400 / px 10）。颜色/描边/圆角在 .gx-cmd（index.css）。
      */}
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="搜索表格记录、知识库文档与画布"
        title="搜索（⌘K）"
        className="gx-cmd shrink-0"
      >
        <Icon name="search" size={13} />
        <span className="gx-cmd-ph hidden md:block">搜索表格记录、知识库文档与画布</span>
        <kbd className="gx-kbd hidden md:inline-block">⌘K</kbd>
      </button>

      {/* 右：同步中心 / 帮助 / 竖线 / 个人中心（gap 6px）。 */}
      <div className="flex flex-none items-center gap-1.5">
        {syncEnabled ? (
          <button
            type="button"
            onClick={() => openSyncCenter()}
            className="gx-top-icon-btn"
            title="同步中心"
            aria-label="打开同步中心"
          >
            <Icon name="sync" size={16} className={syncActive ? "animate-spin" : ""} />
            {syncBadge > 0 ? (
              <span className="absolute right-0.5 top-0.5 min-w-[14px] rounded-full bg-gx-accent px-1 text-center text-gx-10 leading-none text-white tabular-nums">
                {syncBadge > 99 ? "99+" : syncBadge}
              </span>
            ) : null}
          </button>
        ) : null}

        <Link to="/help" className="gx-top-icon-btn" title="帮助中心" aria-label="帮助中心">
          <Icon name="help" size={17} />
        </Link>

        <div className="gx-top-vline" aria-hidden />

        <button
          type="button"
          onClick={() => setPersonalCenterOpen(true)}
          className="gx-who"
          title="打开个人中心"
          aria-label="打开个人中心"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold text-white"
            style={{ backgroundColor: avatarColor(who || "?") }}
          >
            {(who || "?").charAt(0).toUpperCase()}
          </span>
          <span className="gx-who-nm hidden md:inline">{who}</span>
          <Icon name="chevronDown" size={13} className="hidden text-gx-text-hint md:block" />
        </button>
      </div>

      <PersonalCenterDrawer open={personalCenterOpen} onClose={() => setPersonalCenterOpen(false)} />
    </header>
  );
}
