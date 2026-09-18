// M3/S8 新工作区外壳顶栏：左品牌 + 工作区切换（LibrarySwitcher 收入下拉）、
// 中部全局搜索（提权现有 SearchDialog，⌘K 不变）、右侧个人中心。
// 旧两壳的侧栏内搜索按钮/库切换器在新壳由此处统一承接；组件本身不删（flag off 仍用）。
import { useState } from "react";
import { useMatch, useNavigate, useParams } from "react-router-dom";
import { LibrarySwitcher } from "../../components/LibrarySwitcher";
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
  const { baseId: pBaseId, kbId: pKbId } = useParams();
  // 同 PrimaryNav：本组件挂在无 path 的壳层布局路由下，useParams 恒为 {}，
  // 故库切换器的「当前库」改由 useMatch 对 pathname 取参，否则永远显示「选择库」。
  const baseMatch = useMatch("/base/:baseId/*");
  const kbMatch = useMatch("/kb/:kbId/*");
  const baseId = baseMatch?.params.baseId ?? pBaseId ?? null;
  const kbId = kbMatch?.params.kbId ?? pKbId ?? null;
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
      <div className="w-44 shrink-0">
        <LibrarySwitcher active={kbId ? { kind: "kb", id: kbId } : { kind: "base", id: baseId ?? null }} />
      </div>

      {/* 全局搜索（提权顶栏；⌘K 由 Shell 绑定，此处点击同样打开） */}
      <button
        type="button"
        onClick={onOpenSearch}
        className="mx-auto flex h-8 w-full max-w-md items-center gap-2 rounded-gx-md border border-gx-border bg-gx-bg px-2.5 text-gx-12 text-gx-text-tertiary transition-colors hover:bg-gx-row-hover"
      >
        <Icon name="search" size={14} />
        <span className="flex-1 text-left">搜索记录、文档与画布</span>
        <span className="rounded bg-gx-surface px-1 text-gx-11 text-gx-text-hint">⌘K</span>
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
