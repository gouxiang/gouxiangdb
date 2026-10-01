// apps/web/src/features/designer/viewSettingsTabs.ts
// 视图设置宽布局的菜单定义（纯函数，无 React / 无网络）。
//
// 用一个函数根据 view.type 返回菜单项数组。菜单 key 同时是右栏内容块的渲染分支：
//   basic   基础信息（所有视图）：名称 + 锁定模式
//   display 数据展示（form 除外）：显示字段/列序、行高、画廊专属（封面/卡片字段）、类型专属字段
//   detail  详情可见性（所有视图）：详情页字段显示范围
//   filters 查询条件（所有视图）：管理员层强制筛选
//   form    表单配置（仅 form）
//
// 关键约束（戴总反馈点②）：封面 / cardFieldIds 是画廊专属概念，只能在 gallery 视图出现，
// 因此菜单层就把「数据展示」的画廊子块收敛为仅 gallery；具体内容块再按 type 二次判断。

import type { ViewType } from "@gx/shared-types";
import type { IconName } from "../../components/icons";

export type ViewSettingTabKey = "basic" | "display" | "detail" | "filters" | "form";

export interface ViewSettingTab {
  key: ViewSettingTabKey;
  label: string;
  icon: IconName;
}

const ALL_CORE_TABS: ViewSettingTab[] = [
  { key: "basic", label: "基础信息", icon: "settings" },
  { key: "display", label: "数据展示", icon: "grid" },
  { key: "detail", label: "详情可见性", icon: "eye" },
  { key: "filters", label: "查询条件", icon: "filter" },
];

/**
 * 按视图类型返回可见菜单项（顺序即展示顺序）。
 * - form：没有「数据展示」（字段走表单配置），追加「表单配置」。
 * - 其余类型：基础信息 / 数据展示 / 详情可见性 / 查询条件。
 */
export function viewSettingsTabs(type: ViewType): ViewSettingTab[] {
  if (type === "form") {
    return [
      { key: "basic", label: "基础信息", icon: "settings" },
      { key: "detail", label: "详情可见性", icon: "eye" },
      { key: "filters", label: "查询条件", icon: "filter" },
      { key: "form", label: "表单配置", icon: "form" },
    ];
  }
  return ALL_CORE_TABS;
}

/** 取某类型的默认选中菜单（首项）。 */
export function defaultViewSettingsTab(type: ViewType): ViewSettingTabKey {
  return viewSettingsTabs(type)[0].key;
}
