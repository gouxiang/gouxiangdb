// 一级导航顶部「库」区块：库切换器（当前库 + 搜索切换）+ **一个**「新建库」入口。
//
// 入口从顶栏（WorkspaceTopBar）下移到左侧一级导航：建库与切库都在导航里完成，
// 顶栏只留品牌 / 全局搜索 / 个人中心。
//
// 建库弹窗复用 components/CreateLibraryModal（与库切换器里的「新建库」同一份逻辑）。
// 形态沿革：这里原先挂「新建数据库」「新建知识库」**两个**按钮（各预置类型 + fixedType 锁死
// 类型二选一）。2026-09-20 按主理人要求合并成一个「新建库」——点开后在弹窗内二选一库类型，
// 两个创建流程本身一字未动（仍走 CreateLibraryModal 的 base / kb 两条既有分支）。
//
// 行规格与一级导航其它行完全一致（高 32 / 圆角 8 / 图标 14 / 文字 13 / gap 8 /
// 左右 padding 8 / 150ms ease-out），图标只用 icons.tsx 已有的，不新增视觉语言。

import { useState } from "react";
import { Icon } from "../../components/icons";
import { useCanCreateLibrary } from "../../api/hooks";
import { LibrarySwitcher, type ActiveLibrary } from "../../components/LibrarySwitcher";
import { CreateLibraryModal } from "../../components/CreateLibraryModal";

/** 与 PrimaryNav 的 ITEM_SHELL 同一套行规格（不引新视觉语言，折叠档只留图标 + tooltip）。 */
const BLOCK_ROW =
  "flex h-8 w-full items-center gap-2 rounded-gx-lg px-2 text-gx-13 text-gx-text-primary transition-colors duration-150 ease-out hover:bg-gx-row-hover";

/** 单一建库入口：库类型在弹窗内二选一，导航里不再按类型分两个按钮。 */
const CREATE_LABEL = "新建库";

export function NavLibraryBlock({
  active,
  collapsed = false,
}: {
  /** 当前库：由壳层按 pathname 反推（useParams 在壳层布局路由下恒为 {}）。 */
  active: ActiveLibrary;
  /** 一级导航折叠档（56px）：只留图标 + tooltip。 */
  collapsed?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  // 权限门：无 create_library 的用户整个入口不渲染（不是 disabled）——加载中一律按无权限处理。
  const canCreate = useCanCreateLibrary();

  return (
    <div className="flex flex-col">
      <LibrarySwitcher active={active} collapsed={collapsed} />
      {canCreate && (
        <>
          <button
            type="button"
            onClick={() => setCreating(true)}
            title={collapsed ? CREATE_LABEL : undefined}
            aria-label={CREATE_LABEL}
            data-nav-row="library-create"
            className={collapsed ? `${BLOCK_ROW} justify-center px-0` : BLOCK_ROW}
          >
            <Icon name="plus" size={14} className="shrink-0 text-gx-accent" />
            {collapsed ? null : <span className="flex-1 truncate text-left">{CREATE_LABEL}</span>}
          </button>
          {/* 不传 fixedType：弹窗内渲染「智能数据库 / 知识库」二选一，两条创建流程共用一份 */}
          <CreateLibraryModal
            open={creating}
            title={CREATE_LABEL}
            onClose={() => setCreating(false)}
          />
        </>
      )}
    </div>
  );
}
