// apps/web/src/features/settings/role-permission/labels.ts
// 权限配置界面的中文文案真源：十三枚通讯录动作、字段三档、库权限三列、三条硬规则。
//
// 单独成文件的原因：同一句话会同时出现在面板标题、勾选框 title、弹窗说明里，
// 散在各组件里必然出现「改了一处忘了另一处」，而权限文案恰恰是最不能自相矛盾的地方。

import type { FieldAccess, LibraryKind, OrgAction } from "@gx/shared-types";
import { ORG_DIRECTORY_ACTIONS } from "@gx/shared-types";

/** 通讯录面板的可勾动作 = 后端真源，顺序即面板顺序，前端不自己排一遍。 */
export const DIRECTORY_ACTIONS: readonly OrgAction[] = ORG_DIRECTORY_ACTIONS;

/**
 * 十三枚动作的大白话短标签（勾选框上那一行）。
 * 用 Partial 而非 Record<OrgAction,string>：这里只需要覆盖面板那十三枚，
 * 写成全集会让「后端新增一枚动作」变成一次无谓的编译失败，而面板本来就不显示它们。
 */
const LABEL_MAP: Partial<Record<OrgAction, string>> = {
  view_directory: "查看通讯录",
  invite_users: "邀请新成员",
  create_users: "直接建账号",
  disable_users: "停用成员",
  delete_users: "移除成员",
  create_roles: "新建角色",
  edit_roles: "编辑角色",
  delete_roles: "删除角色",
  assign_role_members: "把角色授给成员",
  create_departments: "新建部门",
  edit_departments: "编辑部门",
  delete_departments: "删除部门",
  // 唯一保留的旧粗粒度位：后端「改某人属于哪个部门」仍按它门控，面板必须能勾。
  manage_members: "调整成员部门归属",
};

/** 十三枚动作的一句话解释（挂在 title 上，不占版面）。 */
const HINT_MAP: Partial<Record<OrgAction, string>> = {
  view_directory: "能打开通讯录，看到组织里有哪些人、哪些部门。",
  invite_users: "发邀请链接，让新同事自己激活账号进来。",
  create_users: "直接建一个已激活的账号，不用等对方激活。",
  disable_users: "停用成员，停用后这个人不能再登录。",
  delete_users: "把成员从组织里彻底删掉。",
  create_roles: "新建自定义角色。",
  edit_roles: "改角色的名称、说明和权限（含下面的库权限）。",
  delete_roles: "删除自定义角色。",
  assign_role_members: "决定哪些人、哪些部门持有这个角色。",
  create_departments: "在通讯录里新建部门。",
  edit_departments: "改部门名称、调整部门归到谁下面。",
  delete_departments: "删除部门。",
  manage_members: "把成员加进某个部门或从部门里移出（不改这个人属于哪个角色）。",
};

/** 取标签；未收录的动作回退成动作名本身——显示原始 key 也好过显示空白。 */
export function directoryActionLabel(a: OrgAction): string {
  return LABEL_MAP[a] ?? a;
}

export function directoryActionHint(a: OrgAction): string {
  return HINT_MAP[a] ?? "";
}

/** 字段三档的展示顺序与标签（后端枚举序是 editable/visible/hidden，面板按权限从小到大排）。 */
export const FIELD_ACCESS_ORDER: readonly FieldAccess[] = ["visible", "editable", "hidden"];

export const FIELD_ACCESS_LABEL: Record<FieldAccess, string> = {
  visible: "仅可见",
  editable: "可编辑",
  hidden: "隐藏",
};

export const FIELD_ACCESS_HINT: Record<FieldAccess, string> = {
  visible: "看得到但改不了；公式、自动关联这类系统计算照常写它。",
  editable: "这个人能直接改这个字段。",
  hidden: "这个人看不到这个字段，也改不了。",
};

export const LIBRARY_KIND_LABEL: Record<LibraryKind, string> = {
  base: "数据库",
  kb: "知识库",
};

/** 库权限一行式面板的三列之一：列头文字 + 问号图标上的说明。 */
export interface LibraryScopeColumn {
  key: "manage" | "visible" | "share";
  /** 列头文字。 */
  label: string;
  /** 挂在问号图标（title）上的说明，鼠标移上去可见。 */
  hint: string;
}

/**
 * 库权限面板的三列真源。列头与问号说明放在同一处：
 * 同一句话会同时出现在表头 title、弹窗说明里，散着写必然出现「改了一处忘了另一处」，
 * 而权限文案恰恰最不能自相矛盾。
 */
export const LIBRARY_SCOPE_COLUMNS: readonly LibraryScopeColumn[] = [
  {
    key: "manage",
    label: "可管理",
    hint: "能改这个库的结构、增删改数据、开关分享；勾了可管理就一定能进。",
  },
  {
    key: "visible",
    label: "可见",
    hint: "能进这个库。不进一步设置的话，库里全部内容都是只读可见。",
  },
  {
    key: "share",
    label: "可分享",
    hint: "能把这个库的内容分享出去。库级「允许分享」总开关打开时才生效；勾了可管理自动就有分享权。",
  },
];

/**
 * 三条硬规则：后端现算、不落库（见 apps/api/src/domain/authz/libraryPolicy.ts），
 * 配了也不认。界面上必须把话说清楚，否则管理员会一直找那个并不存在的勾选项。
 */
export const HARD_RULES = {
  createLibrary: {
    label: "建库 / 建知识库",
    who: "仅超级管理员与管理员",
    hint: "不按角色分配：只有超级管理员和管理员能建，这里勾不出来。",
  },
  deleteLibrary: {
    label: "删除库",
    who: "仅超级管理员",
    hint: "不按角色分配：只有超级管理员能删，管理员和管理权限都不行。",
  },
  share: {
    label: "库级「允许分享」开关",
    who: "该库管理权角色或被单独授予「可分享」的角色，再加超级管理员与管理员",
    hint: "谁能管这个库、或被单独授予了这个库的「可分享」，谁才开得了它的分享；其他人连开关都看不到。",
  },
} as const;

/**
 * 外发档位的准确口径（2026-09 分享权限改版后的真值）：
 *   ① 外发有**两档**——只读 / 可编辑，不再"一律只读"；
 *   ② 「可编辑」只发给【分享人本人此刻对该对象有编辑权】的人，且不是一锤子买卖：
 *      分享人后来被降权，链接每次访问都按他当前的权限重算并自动回落只读（后端 shareCaps.ts）。
 * 旧文案「分享链接点进来的人恒为只读」已与实现不符，会让管理员以为这一档不存在。
 */
export const SHARE_MODE_HINT =
  "外发可选「只读」或「可编辑」；可编辑只发给本人此刻就有编辑权的人，且分享人被降权后链接会自动回落只读。";
