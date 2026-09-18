// apps/web/src/features/kb/KbSidebar.tsx
// 知识库侧栏：统一库切换（数据库 + 知识库）+ 全局搜索 + 当前知识库导航（内容/回收站/成员权限）
// + 文档树 + 底部个人信息。与数据表 Sidebar 共用 LibrarySwitcher，视觉/交互一致。
// 颜色全走 gx-* token，图标全用自建 SVG（无 emoji）。

import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/icons";
import { LibrarySwitcher } from "../../components/LibrarySwitcher";
import { useAuthStore } from "../../store/auth";
import { PersonalCenterDrawer } from "../settings/PersonalCenterDrawer";
import { KbTree } from "./KbTree";
import { AVATAR_PALETTE } from "@gx/design-tokens";

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

export function KbSidebar({ onOpenSearch }: { onOpenSearch?: () => void }) {
  const navigate = useNavigate();
  const { kbId } = useParams();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const [personalCenterOpen, setPersonalCenterOpen] = useState(false);

  const loc = location.pathname;
  const inKb = !!kbId;
  const isTrash = loc.includes("/trash");
  const isSettings = loc.includes("/settings");
  const isHome = inKb && !isTrash && !isSettings;

  const navItem = (
    active: boolean,
    icon: Parameters<typeof Icon>[0]["name"],
    label: string,
    onClick: () => void,
  ) => (
    <button
      type="button"
      onClick={onClick}
      className={[
        // R-N-09：选中态 = 白底卡片 + 圆角 8 + accent 600 字，**不用左侧色条**
        "flex w-full items-center gap-2 rounded-gx-lg px-2 py-1.5 text-left text-gx-13 transition-colors",
        active ? "bg-white font-semibold text-gx-accent" : "text-gx-text-primary hover:bg-gx-row-hover",
      ].join(" ")}
    >
      <Icon name={icon} size={14} className={`shrink-0 ${active ? "text-gx-accent" : "opacity-80"}`} />
      <span className="flex-1 truncate">{label}</span>
    </button>
  );

  return (
    <aside className="flex h-full w-60 flex-col border-r border-gx-separator bg-gx-bg">
      {/* 统一库切换 */}
      <div className="border-b border-gx-separator p-2">
        <LibrarySwitcher active={{ kind: "kb", id: kbId ?? null }} />
      </div>

      {/* 全局搜索 */}
      <div className="px-2 py-2">
        <button
          type="button"
          onClick={onOpenSearch}
          className="flex w-full items-center gap-2 rounded-gx-lg border border-gx-border bg-gx-surface px-2 py-1.5 text-gx-12 text-gx-text-tertiary hover:bg-gx-bg"
        >
          <Icon name="search" size={14} />
          <span className="flex-1 text-left">搜索</span>
          <span className="rounded bg-gx-bg px-1 text-gx-11 text-gx-text-hint">⌘K</span>
        </button>
      </div>

      {/* 当前知识库：内容入口 + 文档树（回收站/设置统一移到左下角，与数据表一致） */}
      {inKb ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="px-1.5 pt-1">
            {navItem(isHome, "book", "全部内容", () => navigate(`/kb/${kbId}`))}
          </div>
          <div className="my-1 mx-2 border-t border-gx-separator" />
          <div className="min-h-0 flex-1">
            <KbTree kbId={kbId!} />
          </div>
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {/* 底部：回收站 / 设置 / 个人信息（与数据表侧栏完全一致） */}
      <div className="border-t border-gx-separator p-1.5">
        {inKb && (
          <>
            <button
              type="button"
              onClick={() => navigate(`/kb/${kbId}/trash`)}
              className={[
                // R-N-09：L1 底部选中态同样走白底卡片，不用左侧色条
                "flex w-full items-center gap-2 rounded-gx-lg px-2 py-1.5 text-gx-13 hover:bg-gx-row-hover",
                isTrash ? "bg-white font-semibold text-gx-accent" : "text-gx-text-primary",
              ].join(" ")}
            >
              <Icon name="trash" size={14} className={isTrash ? "text-gx-accent" : undefined} />
              <span>回收站</span>
            </button>
            <button
              type="button"
              onClick={() => navigate(`/kb/${kbId}/settings`)}
              className={[
                // R-N-09：同上
                "flex w-full items-center gap-2 rounded-gx-lg px-2 py-1.5 text-gx-13 hover:bg-gx-row-hover",
                isSettings ? "bg-white font-semibold text-gx-accent" : "text-gx-text-primary",
              ].join(" ")}
            >
              <Icon name="settings" size={14} className={isSettings ? "text-gx-accent" : undefined} />
              <span>设置</span>
            </button>
          </>
        )}

        <div className="relative mt-1 border-t border-gx-separator pt-1.5">
          <button
            type="button"
            onClick={() => setPersonalCenterOpen(true)}
            className="flex w-full items-center gap-2 rounded-gx-sm px-2 py-1.5 hover:bg-gx-row-hover"
            title="打开个人中心"
            aria-label="打开个人中心"
          >
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-gx-11 font-semibold text-white"
              style={{ backgroundColor: avatarColor(user?.displayName ?? user?.email ?? "?") }}
            >
              {(user?.displayName ?? user?.email ?? "?").charAt(0).toUpperCase()}
            </span>
            <span className="flex-1 truncate text-left text-gx-12 text-gx-text-primary">
              {user?.displayName ?? user?.email}
            </span>
            <Icon name="settings" size={14} className="text-gx-text-tertiary" />
          </button>
        </div>
      </div>

      {/* 个人中心 Drawer（点击左下角头像/名字打开） */}
      <PersonalCenterDrawer open={personalCenterOpen} onClose={() => setPersonalCenterOpen(false)} />
    </aside>
  );
}
