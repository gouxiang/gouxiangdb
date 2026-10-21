// L1 图标轨底部固定区菜单项单一真源（v6 底板 RAIL_FOOT 顺序，2026-10 UI 重做 S1）。
//
// 单独成文件的原因：底部三项既要被 WorkspaceShell 的 RailFoot 渲染，也要被单测直接断言
// （「图标语义映射」逐项核对），放在组件文件里只能靠读源码断言，等于没断言。
//
// v6 S1 顺序照底板 RAIL_FOOT：通讯录 → 帮助中心 → 工作区设置。
// 通讯录图标由 building 换 users（双人剪影，与「组织/成员」语义一致）。
import type { IconName } from "../../../components/icons";

export interface FooterNavItem {
  path: string;
  icon: IconName;
  label: string;
}

/**
 * 帮助中心：内容型静态入口——任何角色都可见，**不参与能力门控**（门控表见
 * lib/nav-gate.ts 的 STATIC_FOOTER_PATHS）。它跟管理类入口不同：读文档不需要任何
 * 组织能力，按能力过滤反而会让普通成员找不到说明入口。
 *
 * 通讯录与工作区设置按 lib/nav-gate.ts 的能力门控 fail-closed 过滤；
 * 入口分区必须指向 WorkspaceSettingsPage 的**现存**分区（现为 /workspace/settings/general）。
 * 改动这里请同步 lib/nav-gate.ts 的门控 case。
 */
export const FOOTER_NAV_ITEMS: readonly FooterNavItem[] = [
  { path: "/workspace/contacts", icon: "users", label: "通讯录" },
  { path: "/help", icon: "help", label: "帮助中心" },
  { path: "/workspace/settings/general", icon: "settings", label: "工作区设置" },
];
