// packages/design-tokens/src/colors.ts
// 从 v1 Shared/Theme.swift GXTheme 1:1 移植
// 跨端统一语义色（前后端 + Tailwind + Web 共享）

export const colors = {
  // 品牌主色（v1 GXTheme.accent）
  accent: "#378ADD",
  accentBg: "rgba(55, 138, 221, 0.12)",
  accentHover: "rgba(55, 138, 221, 0.20)",

  // 文本层级（v1 textPrimary/textSecondary/textTert）
  textPrimary: "#26215C",
  textSecondary: "#534AB7",
  textTertiary: "#5F5E5A",
  textHint: "#888780",

  // 表面层级（v1 surface/bg/cardBg/zebra）
  bg: "#F1EFE8", // 页面底色（v1 灰底）
  surface: "#FFFFFF", // 主面板（v1 工作台白底）
  cardBg: "#F1EFE8", // 卡片画布（v1 画廊浅灰画布）
  zebra: "#F1EFE8", // 表格斑马纹

  // 边框（v1 separator/border）
  separator: "rgba(0, 0, 0, 0.06)",
  border: "rgba(0, 0, 0, 0.10)",
  borderStrong: "rgba(0, 0, 0, 0.20)",

  // 行 hover
  rowHover: "rgba(0, 0, 0, 0.05)",

  // 表头
  tableHeader: "#F1EFE8",
  headerEdge: "rgba(0, 0, 0, 0.04)",

  // 语义
  success: "#1D9E75",
  successBg: "rgba(29, 158, 117, 0.10)",
  warning: "#BA7517",
  warningBg: "rgba(186, 117, 23, 0.10)",
  danger: "#E24B4A",
  dangerBg: "rgba(226, 75, 74, 0.10)",
  /** 次级强调色（亮紫）：画布/文档/嵌套卡片等"次级主题" */
  secondaryAlt: "#7F77DD",
} as const;

export type ColorToken = keyof typeof colors;

/**
 * 头像/图标底色：按昵称稳定取色用（hash % len）。
 * 与 v1 颜色家族一致：accent / success / warning / secondary 围绕主色分布，
 * 避免视觉堆叠成「一片蓝色」。仅作为前端 JS 取色入口使用，色值集中管理。
 */
export const AVATAR_PALETTE: readonly string[] = [
  "#378ADD", // accent
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