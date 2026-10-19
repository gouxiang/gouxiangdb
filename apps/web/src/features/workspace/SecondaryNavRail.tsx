// L2 收起态唤回入口（常驻档 ≥1280 使用）。
//
// 2026-10-19 交互调整（戴总真机目验）：收起后**不再保留任何竖栏**——旧版那条 56px、
// 竖排显示容器名的窄条仍占据内容宽度且显得「没收干净」。改为彻底收起（零尺寸、不占位），
// 只在一级导航（L1）右缘的垂直中点保留一个圆形悬浮小箭头作为唯一唤回入口。
//
// 定位：absolute 骑在 L1 右缘（left = L1 宽 − 半个钮，由壳层按当前 L1 实际宽度传入），
// 父级是 WorkspaceShell 内 `relative flex ...` 的行容器，故相对该行定位、垂直居中。
// 浮出档（R-D-31/32，768–1279）不渲染本件：那档唤回入口在 L1 底部固定区（secondaryToggle）。
import { Icon } from "../../components/icons";

export function SecondaryNavRail({
  containerName,
  onExpand,
  /** L1 当前宽度（展开 196 / 折叠 56），用于把箭头骑在其右缘。 */
  l1Width,
}: {
  /** 收起的容器名：仅用于 tooltip / aria-label，不再竖排展示。 */
  containerName: string;
  onExpand: () => void;
  l1Width: number;
}) {
  const label = `展开「${containerName}」二级面板`;
  return (
    <button
      type="button"
      onClick={onExpand}
      title={label}
      aria-label={label}
      aria-expanded={false}
      className="gx-l2-expand-tab gx-z-drawer absolute top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-gx-border bg-gx-surface text-gx-text-secondary shadow-gx-md transition-colors hover:bg-gx-row-hover hover:text-gx-text-primary"
      // 骑在 L1 右缘：钮中心落在 L1 右边线上（再向外露一半）。
      style={{ left: l1Width - 14 }}
      data-l2="collapsed-tab"
    >
      {/* 收起态箭头朝右＝向右拉回二级面板；与展开态的朝左收起箭头互为反向。 */}
      <Icon name="chevronRight" size={15} />
    </button>
  );
}
