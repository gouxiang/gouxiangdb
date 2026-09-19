// L1 底部固定区菜单项单一真源（D-5 §2.2 定稿顺序）。
//
// 单独成文件的原因：底部四项既要被 WorkspaceShell 渲染，也要被单测直接断言
// （「图标语义映射」逐项核对），放在组件文件里只能靠读源码断言，等于没断言。
import type { IconName } from "../../../components/icons";

export interface FooterNavItem {
  path: string;
  icon: IconName;
  label: string;
}

/**
 * 菜单精细化：图标按语义重排——工作区设置由 database 改为 settings
 * （database 语义是「数据库实体」，挂在设置入口上错配）。
 *
 * 第三批导航重构：「导航编排」（/workspace/settings/nav）随 menu_items 手动收纳机制
 * 一并下线，故这里从四项降为三项；该路径此后回落到工作区设置通用分区（不再可达）。
 */
export const FOOTER_NAV_ITEMS: readonly FooterNavItem[] = [
  { path: "/workspace/contacts", icon: "building", label: "通讯录" },
  { path: "/workspace/authz", icon: "shield", label: "权限管理" },
  { path: "/workspace/settings/assets", icon: "settings", label: "工作区设置" },
];
