// packages/design-tokens/src/colors.ts
// 语义色令牌：取值对齐 v6 底板设计体系
// （docs/design/2026-10-ui-redesign/actual/v6/src/shared.css :root，HANDOFF R1 裁决）
// 跨端统一语义色（前后端 + Tailwind + Web 共享）
// 注意：Tailwind 类名（bg-gx-* / text-gx-* / border-gx-*）与本文件键名保持不变，只换底层取值。
// 历史：旧板取色（#3A6DF0/#F7F9FC/#E9EFF9…，出自 2026-09 UI-SPEC A.1）已由 R1 整板作废，
//       以 v6 底板为唯一真源；含红黄绿状态色在内整套跟随底板。

export const colors = {
  // 品牌主色（底板 --brand / --brand-ink / --brand-soft）
  accent: "#2c7be5",
  accentBg: "#eaf2fe",
  accentHover: "#1f5fbf",
  /** 选中底（与 accentBg 同值，语义别名：数据行/Tab/L1 选中态） */
  selected: "#eaf2fe",

  // 文本层级（底板墨色四级 --ink-1..4；第五级 faint 在 ink-4 基础上再柔一档）
  textPrimary: "#101828",
  textSecondary: "#475467",
  textTertiary: "#667085",
  textHint: "#8b95a7",
  textFaint: "#a7b0c0",

  // 表面层级（底板 --bg/--card/--sub/--hover）
  bg: "#f4f6fa", // 页面/内容区底
  nav1: "#f7f9fd", // L1 图标轨底（近白基色；阶段1再叠 180deg 白→#eef2f8 渐变）
  nav2: "#ffffff", // L2 二级面板底（底板 .l2-inner = --card 白）
  surface: "#FFFFFF", // 主面板 / 卡片
  tableHeader: "#f7f9fc", // 表头 / 汇总条（底板 --sub）
  control: "#f7f9fc", // 输入框 / 次按钮 / 全局搜索底（底板 --sub，平面不做凹槽）
  /** hover 底（与 rowHover 同值，语义别名；底板 --hover） */
  hover: "#f5f8fd",
  rowHover: "#f5f8fd",

  // 边框与分隔（底板 --line / hover 边线 / 滚动条等）
  hairline: "#e7eaf0", // 发丝线 / 顶带与面板头同色边线
  border: "#d6dce8", // 控件 hover 边线
  borderStrong: "#c6ceda", // 更强一档（滚动条 thumb hover 等）
  dividerV: "#e7eaf0", // 竖向分隔 1×16

  // 标识块 / 头像示例色
  logoBlock: "#eaf2fe", // 品牌软底
  avatarSample: "#f5a623", // 底板暖黄（头像示例占位）

  // 语义（底板 --ok/--danger + 暖黄 --warm；soft 底取不透明软色，非 rgba，便于任意底色复用）
  success: "#0e9f6e",
  successBg: "#e6f6ef",
  warning: "#f5a623",
  warningBg: "#fef4e4",
  danger: "#d92d20",
  dangerBg: "#fdecea",
  /** 次级强调色（亮紫）：画布/文档/嵌套卡片等"次级主题"（底板 --violet） */
  secondaryAlt: "#7b4cd8",
  /** 次级强调软底（底板 --violet-soft） */
  secondaryAltBg: "#f2ecfe",

  // —— 以下为 v1 GXTheme 遗留令牌：v1 暖灰板（#F1EFE8 系）整族收编为冷灰，
  //    键名保留供旧类名/旧 JS 引用继续生效，取值随 v6 冷板，不再保留暖灰色相。——
  cardBg: "#f7f9fc", // 卡片画布（原 v1 暖灰，现 = --sub 冷灰）
  zebra: "#f7f9fc", // 表格斑马纹
  separator: "rgba(16, 24, 40, 0.08)", // 通用分隔（墨色冷调）
  headerEdge: "rgba(16, 24, 40, 0.06)", // 顶边轻分隔（墨色冷调）
} as const;

export type ColorToken = keyof typeof colors;

/**
 * 头像/图标底色：按昵称稳定取色用（hash % len）。
 * 取色对齐 v6 底板头像六条渐变末色（brand/violet/ok/warm/danger/青），
 * 补两枚同家族深色，避免视觉堆叠成「一片蓝色」。仅作为前端 JS 取色入口使用，色值集中管理。
 */
export const AVATAR_PALETTE: readonly string[] = [
  "#2c7be5", // brand
  "#7b4cd8", // violet
  "#0e9f6e", // ok
  "#f5a623", // warm
  "#d92d20", // danger
  "#2f9fd0", // 青（底板 av-f）
  "#0f6e56", // 深绿
  "#1f5fbf", // 深品牌蓝
] as const;

// 字段类型颜色（v1 GXFieldIcon）：字段分类色板，属「用户数据/分类语义」配色，
// 与品牌主题板解耦——R1 换板不动此表（2026-10 UI 重构裁决）。
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
