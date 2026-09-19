// L1 底部固定区四项的能力门控（交互治理第一批，渲染侧单一真源）。
//
// 背景：lib/nav-footer.ts 的四项定义是「菜单的外观与顺序」，不含权限语义；
//       WorkspaceShell.FooterNav 原先无条件 map 渲染，任何账号都能看到这四个管理入口。
//       本文件只回答「某账号能不能看到某入口」，不动四项定义本身。
//
// 两套能力口径并存是已知现状（统一它们是后续架构项，本次不做）：
//   ① 组织动作集合 actions（/api/v1/org/members/me/effective-roles 聚合的五枚 OrgAction，
//      目前仅系统角色 owner 持有，其余四枚系统角色 permissions=[]）；
//   ② 权限引擎能力位 authzManage（GET /api/v1/meta，featuregate.ts:canManageAuthz 的严格 ===true）。
//      注意：后端 /meta 目前**从不下发 authzManage**（apps/api/src/routes/v1/index.ts:36-49
//      只返 {apiVersion, enterpriseOrg, auth}），故该口径在当前环境恒 false——
//      因此入口不能只挂它，否则连所有者都看不到「权限管理」；这里用 OR 让两者各自都能生效。
//
// 全部 fail-closed：空集 / 未传 / 探针未完成（loading）一律判不可见，
// 避免「先闪出管理入口、探针回来再消失」的跳变。
import type { OrgAction } from "@gx/shared-types";
import type { FooterNavItem } from "./nav-footer";

/** 本次判定所需的信号；actions 是 Set 便于 O(1)，也接受空集合表示无能力。 */
export interface FooterNavCapabilities {
  actions: ReadonlySet<OrgAction>;
  /** 权限引擎写入口门控放行（authzManage === true）。 */
  authzManage: boolean;
  /** 能力探针未完成：按无能力处理（fail-closed）。 */
  loading?: boolean;
}

/** 通讯录：同 ContactsPage.tsx:14-16 的三枚组织动作口径（部门/成员/角色任一写权限）。 */
const CONTACTS_ACTIONS: readonly OrgAction[] = [
  "manage_departments",
  "manage_members",
  "manage_roles",
];

export function canSeeContacts(actions: ReadonlySet<OrgAction>): boolean {
  return CONTACTS_ACTIONS.some((a) => actions.has(a));
}

/**
 * manage_menu 动作：原「导航编排」入口的口径。第三批重构后该入口已下线
 * （FOOTER_NAV_ITEMS 不再含 /workspace/settings/nav），只保留给
 * canSeeWorkspaceSettings 作为「持任一枚组织管理动作」的兜底判定之一。
 */
export function canSeeNavComposer(actions: ReadonlySet<OrgAction>): boolean {
  return actions.has("manage_menu");
}

/**
 * 权限管理：两套口径任一放行。
 *   ① authzManage（权限引擎能力位，后端下发后才生效）；
 *   ② manage_share（组织面「授权策略/分享管理」动作，PermNodeEditor 写权限用的同一枚）。
 * 用 OR 而不是二选一：任一信号到位都能看见入口，将来补 /meta 下发或给自定义角色勾选都零返工。
 *
 * P2-B1：为什么入口从 FooterNav 移除但函数保留——
 *   /workspace/authz 的 L1 入口已并入工作区设置（见 nav-footer.ts），但同一个判定仍被两处
 *   真实使用：① PermPanel.tsx 直访 /workspace/authz 时的页面级门控；② 设置页「权限管理」
 *   分区所需的「有无授权管理能力」口径（见 WorkspaceSettingsPage 的 authz 分区）。删它会
 *   让这两处各自重写一遍条件，等于把单一的口径真源拆成三份。
 */
export function canSeeAuthz(actions: ReadonlySet<OrgAction>, authzManage: boolean): boolean {
  return authzManage === true || actions.has("manage_share");
}

/**
 * 工作区设置（资产入口）：没有专属能力信号的兜底口径。
 * WorkspaceSettingsPage 只对「语义检索」用 ownerOnly/assets 未加任何门控，
 * 因此这里按「是否持任一枚组织管理动作」判可见——持任一枚即参与组织管理，
 * 一枚都没有的成员（viewer/commenter）不该从这个位置进到任何工作区配置页。
 */
export function canSeeWorkspaceSettings(actions: ReadonlySet<OrgAction>): boolean {
  return CONTACTS_ACTIONS.some((a) => actions.has(a)) || canSeeNavComposer(actions) || actions.has("manage_share");
}

/** 按 path 把单一入口映射到它自己那套判定（新增入口必须在此登记，否则默认不可见）。 */
export function isFooterNavVisible(path: string, caps: FooterNavCapabilities): boolean {
  // authzManage 不再参与底部区判定（P2-B1：权限入口已迁入设置页分区），
  // 但 caps 仍然携带它——同一份能力信号还要喂给设置页的权限分区，接口字段不动。
  const { actions, loading } = caps;
  if (loading) return false;
  switch (path) {
    case "/workspace/contacts":
      return canSeeContacts(actions);
    // P2-B1：/workspace/authz 的 case 已删除——该入口不再是底部区的一项，
    // 未知路径一律落 default return false，不猜不放行。它的可见性判定搬到
    // canSeeAuthz 的两处真实调用方（PermPanel 直访门控、设置页权限分区）。
    // /workspace/settings/nav（导航编排）第三批已下线，同样落默认分支。
    case "/workspace/settings/assets":
      return canSeeWorkspaceSettings(actions);
    default:
      // 未知入口不猜、不兜底放行；说不清判定的入口不该出现在管理区。
      return false;
  }
}

/**
 * 过滤后的可渲染项，**保持 nav-footer.ts 的定稿顺序**（D-5 §2.2）。
 * 返回新数组，不修改入参（nav-footer.ts 的常量是只读单一真源）。
 */
export function visibleFooterNav(
  items: readonly FooterNavItem[],
  caps: FooterNavCapabilities,
): FooterNavItem[] {
  return items.filter((it) => isFooterNavVisible(it.path, caps));
}
