// L2 收起态唤回入口（常驻档 ≥1280 使用）。
//
// 2026-10-19 交互调整（戴总真机目验）：收起后**不再保留任何竖栏**——旧版那条 56px、
// 竖排显示容器名的窄条仍占据内容宽度且显得「没收干净」。改为彻底收起（零尺寸、不占位），
// 只在一级导航（L1）右缘的垂直中点保留一个圆形悬浮小箭头作为唯一唤回入口。
//
// v6 S3 横向栅格：外壳改成底板 .app 的 flex-row 两段（rail 全高左列 / 右列=顶栏+内容体）。
// 本钮渲染在右列内容体（position:relative）内，其左缘即轨道右缘（x=76），故定位写死
// left:-13（26px 钮再向左露一半），视觉同点骑在轨道右缘中线上；组件不再接收任何宽度入参。
// 垂直居中靠 .gx-l2-toggle 的 top:50% translateY(-50%)（index.css）。
// v6 S2：与展开态收起钮同走底板 .l2-toggle 规格（26×26），视觉类 gx-l2-toggle 在
// index.css；z 层级仍挂 tailwind gx-z-drawer（层级裁决锁定）。
// 浮出档（R-D-31/32，768–1279）不渲染本件：那档唤回入口在 L1 底部固定区（secondaryToggle）。
import { Icon } from "../../components/icons";

export function SecondaryNavRail({
  containerName,
  onExpand,
}: {
  /** 收起的容器名：仅用于 tooltip / aria-label，不再竖排展示。 */
  containerName: string;
  onExpand: () => void;
}) {
  const label = `展开「${containerName}」二级面板`;
  return (
    <button
      type="button"
      onClick={onExpand}
      title={label}
      aria-label={label}
      aria-expanded={false}
      className="gx-l2-expand-tab gx-l2-toggle gx-z-drawer"
      // 骑在右列内容体左缘（= rail 右缘 x=76）：钮中线落在 rail 右边线上（向外露一半 = −13）。
      style={{ left: -13 }}
      data-l2="collapsed-tab"
    >
      {/* 收起态箭头朝右＝向右拉回二级面板；与展开态的朝左收起箭头互为反向。 */}
      <Icon name="chevronRight" size={14} />
    </button>
  );
}
