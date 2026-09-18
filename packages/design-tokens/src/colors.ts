// packages/design-tokens/src/colors.ts
// 语义色令牌：取值对齐参考设计（docs/design/2026-09-ui-restructure/UI-SPEC.md 附录 A.1）
// 跨端统一语义色（前后端 + Tailwind + Web 共享）
// 注意：Tailwind 类名（bg-gx-* / text-gx-* / border-gx-*）保持不变，只换底层取值。

export const colors = {
  // 品牌主色
  accent: "#3A6DF0",
  accentBg: "#EAF2FC",
  accentHover: "#2F5FD6",
  /** 选中底（与 accentBg 同值，语义别名：数据行/Tab 选中态） */
  selected: "#EAF2FC",

  // 文本层级
  textPrimary: "#16203A",
  textSecondary: "#2A3550",
  textTertiary: "#5B6785",
  textHint: "#8A94AC",
  textFaint: "#A6AFC6",

  // 表面层级
  bg: "#F7F9FC", // 页面/内容区底
  nav1: "#E9EFF9", // L1 一级导航底
  nav2: "#F4F8FD", // L2 二级面板底
  surface: "#FFFFFF", // 主面板
  tableHeader: "#F9FAFC", // 表头 / 汇总条（= gx-surface-alt）
  control: "#F4F6FA", // 输入框 / 次按钮 / 全局搜索底
  /** hover 底（与 rowHover 同值，语义别名） */
  hover: "#F1F5FB",
  rowHover: "#F1F5FB",

  // 边框与分隔
  hairline: "#E9EFF9", // 发丝线
  border: "#DFE3EA",
  borderStrong: "#C3CAD6",
  dividerV: "#E1E7F1", // 竖向分隔 1×16

  // 标识块 / 头像示例色
  logoBlock: "#E6EDFF",
  avatarSample: "#E08A34",

  // 语义
  success: "#1D9E75",
  successBg: "rgba(29, 158, 117, 0.10)",
  warning: "#BA7517",
  warningBg: "rgba(186, 117, 23, 0.10)",
  danger: "#E24B4A",
  dangerBg: "rgba(226, 75, 74, 0.10)",
  /** 次级强调色（亮紫）：画布/文档/嵌套卡片等"次级主题" */
  secondaryAlt: "#7F77DD",

  // —— 以下为 v1 GXTheme 遗留令牌（附录 A 未列，本次原样保留，去留由后续切片决定）——
  cardBg: "#F1EFE8", // 卡片画布（v1 画廊浅灰画布）
  zebra: "#F1EFE8", // 表格斑马纹
  separator: "rgba(0, 0, 0, 0.06)",
  headerEdge: "rgba(0, 0, 0, 0.04)",
} as const;

export type ColorToken = keyof typeof colors;

/**
 * 头像/图标底色：按昵称稳定取色用（hash % len）。
 * 与 v1 颜色家族一致：accent / success / warning / secondary 围绕主色分布，
 * 避免视觉堆叠成「一片蓝色」。仅作为前端 JS 取色入口使用，色值集中管理。
 */
export const AVATAR_PALETTE: readonly string[] = [
  "#3A6DF0", // accent（随主色令牌同步）
  "#1D9E75", // success
  "#993556", // 深玫红
  "#BA7517", // warning
  "#534AB7", // secondary
  "#0F6E56", // 深绿
  "#D4537E", // 亮玫红
  "#7F77DD", // 亮紫
] as const;

// 字段类型颜色（v1 GXFieldIcon）
export const FIELD_TYPE_COLOR: Record<string, string> = {
  singleLineText: "#8B5CF6",
  longText: "#8B5CF6",
  number: "#3B82F6",
  currency: "#10B981",
  percent: "#F59E0B",
  date: "#A855F7",
  dateTime: "#A855F7",
  checkbox: "#06B6D4",
  singleSelect: "#14B8A6",
  multiSelect: "#14B8A6",
  rating: "#F59E0B",
  url: "#3B82F6",
  email: "#3B82F6",
  phone: "#3B82F6",
  user: "#06B6D4",
  attachment: "#6B7280",
  links: "#22C55E",
  lookup: "#22C55E",
  rollup: "#EC4899",
  count: "#EC4899",
  formula: "#EC4899",
  barcode: "#6B7280",
  duration: "#A855F7",
  autoNumber: "#9CA3AF",
  createdTime: "#9CA3AF",
  lastModifiedTime: "#9CA3AF",
  createdBy: "#9CA3AF",
  lastModifiedBy: "#9CA3AF",
};