// M3/S8 新工作区外壳顶栏：左品牌、中部全局搜索（提权现有 SearchDialog，⌘K 不变）、右侧个人中心。
// 库切换器与新建库入口已下移到左侧一级导航 NavLibraryBlock（建库/切库都发生在导航里）；
// LibrarySwitcher 组件本身不删（旧两壳 Sidebar/KbSidebar 仍在用）。
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../components/icons";
import { useAuthStore } from "../../store/auth";
import { AVATAR_PALETTE } from "@gx/design-tokens";
import { PersonalCenterDrawer } from "../settings/PersonalCenterDrawer";

function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

export function WorkspaceTopBar({ onOpenSearch }: { onOpenSearch: () => void }) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [personalCenterOpen, setPersonalCenterOpen] = useState(false);

  return (
    // 骨架 S-1（UI-SPEC A.3）：顶栏高 56、左右 padding 20、元素间距 12。
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-gx-hairline bg-gx-surface px-5">
      {/* 品牌 + 工作区切换 */}
      <button
        type="button"
        onClick={() => navigate("/")}
        className="flex shrink-0 items-center gap-1.5 rounded-gx-sm px-1 py-1 hover:bg-gx-bg"
        title="构想工作台"
      >
        <Icon name="database" size={16} className="text-gx-accent" />
        <span className="hidden text-gx-13 font-semibold text-gx-text-primary lg:inline">构想工作台</span>
      </button>

      {/*
        库切换器与「新建库」入口已下移到左侧一级导航（NavLibraryBlock）：
        建库/切库都发生在导航里，顶栏只留品牌 / 全局搜索 / 个人中心。
        搜索按钮自带 mx-auto，撤下切换器后剩余空间由它吃掉，不留空位。
      */}
      {/*
        全局搜索（提权顶栏；⌘K 由 Shell 绑定，此处点击同样打开）。
        R-D-33（<768）：折叠为 32×32 图标按钮。原实现是 `w-full max-w-md` 的长文案按钮，
        窄屏下被压到内容宽度以下后中文逐字换行（与工具栏同一类断行），且规范本档就要求
        「顶栏搜索折叠为图标」。≥768 的形态与改动前完全一致（文案、⌘K 徽标、mx-auto 居中）。
      */}
      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="搜索记录、文档与画布"
        title="搜索（⌘K）"
        className="mx-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-gx-lg border border-gx-border bg-gx-bg text-gx-12 text-gx-text-tertiary transition-colors hover:bg-gx-row-hover md:w-full md:max-w-md md:justify-start md:gap-2 md:px-2.5"
      >
        <Icon name="search" size={14} />
        <span className="hidden min-w-0 flex-1 truncate whitespace-nowrap text-left md:block">
          搜索记录、文档与画布
        </span>
        <span className="hidden rounded bg-gx-surface px-1 text-gx-11 text-gx-text-hint md:inline-block">
          ⌘K
        </span>
      </button>

      {/* 个人中心（真实入口：资料/账号；不放假"帮助"占位） */}
      <button
        type="button"
        onClick={() => setPersonalCenterOpen(true)}
        className="ml-auto flex shrink-0 items-center gap-2 rounded-gx-sm py-1 pl-1 pr-2 hover:bg-gx-bg lg:ml-0"
        title="打开个人中心"
        aria-label="打开个人中心"
      >
        <span
          className="flex h-6 w-6 items-center justify-center rounded-full text-gx-11 font-semibold text-white"
          style={{ backgroundColor: avatarColor(user?.displayName ?? user?.email ?? "?") }}
        >
          {(user?.displayName ?? user?.email ?? "?").charAt(0).toUpperCase()}
        </span>
      </button>

      <PersonalCenterDrawer open={personalCenterOpen} onClose={() => setPersonalCenterOpen(false)} />
    </header>
  );
}
