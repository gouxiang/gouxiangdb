// 一级导航顶部「库」区块：库切换器（当前库 + 搜索切换）+ 明确的「新建数据库 / 新建知识库」。
//
// 入口从顶栏（WorkspaceTopBar）下移到左侧一级导航：建库与切库都在导航里完成，
// 顶栏只留品牌 / 全局搜索 / 个人中心。
// 建库弹窗复用 components/CreateLibraryModal（与库切换器里的「新建库」同一份逻辑），
// 这里只是把类型预置好，让两个入口各自明确。
//
// 行规格与一级导航其它行完全一致（高 32 / 圆角 8 / 图标 14 / 文字 13 / gap 8 /
// 左右 padding 8 / 150ms ease-out），图标只用 icons.tsx 已有的，不新增视觉语言。

import { useState } from "react";
import { Icon, type IconName } from "../../components/icons";
import { LibrarySwitcher, type ActiveLibrary } from "../../components/LibrarySwitcher";
import { CreateLibraryModal, type LibType } from "../../components/CreateLibraryModal";

/** 与 PrimaryNav 的 ITEM_SHELL 同一套行规格（不引新视觉语言，折叠档只留图标 + tooltip）。 */
const BLOCK_ROW =
  "flex h-8 w-full items-center gap-2 rounded-gx-lg px-2 text-gx-13 text-gx-text-primary transition-colors duration-150 ease-out hover:bg-gx-row-hover";

const CREATE_ENTRIES: readonly { type: LibType; icon: IconName; label: string }[] = [
  { type: "base", icon: "database", label: "新建数据库" },
  { type: "kb", icon: "book", label: "新建知识库" },
];

export function NavLibraryBlock({
  active,
  collapsed = false,
}: {
  /** 当前库：由壳层按 pathname 反推（useParams 在壳层布局路由下恒为 {}）。 */
  active: ActiveLibrary;
  /** 一级导航折叠档（56px）：只留图标 + tooltip。 */
  collapsed?: boolean;
}) {
  const [creating, setCreating] = useState<LibType | null>(null);

  return (
    <div className="flex flex-col">
      <LibrarySwitcher active={active} collapsed={collapsed} />
      {CREATE_ENTRIES.map((e) => (
        <button
          key={e.type}
          type="button"
          onClick={() => setCreating(e.type)}
          title={collapsed ? e.label : undefined}
          aria-label={e.label}
          data-nav-row="library-create"
          className={collapsed ? `${BLOCK_ROW} justify-center px-0` : BLOCK_ROW}
        >
          <Icon name={e.icon} size={14} className="shrink-0 text-gx-accent" />
          {collapsed ? null : <span className="flex-1 truncate text-left">{e.label}</span>}
        </button>
      ))}
      <CreateLibraryModal
        open={creating !== null}
        title={creating === "kb" ? "新建知识库" : "新建数据库"}
        initialType={creating ?? "base"}
        fixedType
        onClose={() => setCreating(null)}
      />
    </div>
  );
}
