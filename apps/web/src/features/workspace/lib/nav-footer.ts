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
 *
 * P2-B1：「权限管理」从 L1 底部区移出，改为工作区设置的一个分区（内嵌 PermPanel）——
 * 它和「通讯录」一样只是设置下的一个分区，占 L1 固定区一根位置不必要；路由
 * /workspace/authz 保留（直访不 404），只是不再有独立导航入口。故此处由三项降为两项。
 *
 * 帮助中心：内容型静态入口——任何角色都可见，**不参与能力门控**（门控表见
 * lib/nav-gate.ts 的 STATIC_FOOTER_PATHS）。它跟管理类入口不同：读文档不需要任何
 * 组织能力，按能力过滤反而会让普通成员找不到说明入口。
 *
 * 入口分区必须指向 WorkspaceSettingsPage 的**现存**分区（现为 /workspace/settings/general）：
 * 「资产」分区已下线，指向它只能靠「未知 splat 落通用」的兜底渲染才不白屏，
 * 结果是地址栏与左栏高亮的分区对不上。改动这里请同步 lib/nav-gate.ts 的门控 case。
 */
export const FOOTER_NAV_ITEMS: readonly FooterNavItem[] = [
  { path: "/workspace/contacts", icon: "building", label: "通讯录" },
  { path: "/workspace/settings/general", icon: "settings", label: "工作区设置" },
  { path: "/help", icon: "help", label: "帮助中心" },
];
