// L2 收起态窄条（56，与 L1 折叠档同规格）。
//
// 存在理由：常驻档（≥1280）L2 收起后原来宽度归零、且壳层没有任何还原入口 —— 收起等于
// 把二级导航永久删掉。故收起后必须留一条竖栏：既是「这里折叠了一列」的位置提示，也是唤回入口。
//
// 浮出档（R-D-31/32，768–1279）不渲染本条：那档 L2 是覆盖内容区的浮层，再插一条 56 的
// 常驻竖栏等于反向挤压内容宽度。那档的唤回入口在 L1 底部固定区（WorkspaceShell.secondaryToggle）。
import { Icon } from "../../components/icons";
import { L2_WIDTH_COLLAPSED } from "./lib/l2-collapse";

export function SecondaryNavRail({
  containerName,
  onExpand,
  width = L2_WIDTH_COLLAPSED,
}: {
  /** 折叠的容器名：竖排显示 + tooltip，让用户知道收起的是哪一列。 */
  containerName: string;
  onExpand: () => void;
  width?: number;
}) {
  const label = `展开「${containerName}」二级面板`;
  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r border-gx-hairline bg-gx-nav2"
      style={{ width }}
      data-l2="collapsed"
    >
      {/* 整条就是一个唤回按钮：56px 宽的全高点击区，收起后误触成本最低的还原方式 */}
      <button
        type="button"
        onClick={onExpand}
        title={label}
        aria-label={label}
        aria-expanded={false}
        className="flex h-full w-full flex-col items-center text-gx-text-tertiary transition-colors hover:bg-gx-row-hover hover:text-gx-text-primary"
      >
        <span className="flex h-[52px] w-full shrink-0 items-center justify-center border-b border-gx-hairline">
          <Icon name="chevronRight" size={14} />
        </span>
        <span className="flex min-h-0 flex-1 items-start justify-center overflow-hidden py-2">
          <span
            className="max-h-full overflow-hidden text-gx-12"
            style={{ writingMode: "vertical-rl" }}
            title={containerName}
          >
            {containerName}
          </span>
        </span>
      </button>
    </aside>
  );
}
