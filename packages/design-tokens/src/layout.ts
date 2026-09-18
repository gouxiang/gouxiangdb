// packages/design-tokens/src/layout.ts
// 从 v1 GXTheme 间距/圆角/字号 1:1 移植

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 20,
  "3xl": 24,
  "4xl": 32,
  "5xl": 40,
  "6xl": 48,
} as const;

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 10,
  "2xl": 12,
  "3xl": 16,
  full: 9999,
} as const;

export const fontSize = {
  x11: 11,
  x12: 12,
  x13: 13,
  x14: 14,
  // R-D-02 字号九档含 15（面板标题 / 页头标题等）；此前令牌缺这一档，业务侧 text-gx-15 静默无效。
  x15: 15,
  x16: 16,
  x18: 18,
  x20: 20,
  x24: 24,
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export const shadow = {
  sm: "0 1px 2px rgba(0, 0, 0, 0.04)",
  md: "0 2px 6px rgba(0, 0, 0, 0.08)",
  lg: "0 4px 12px rgba(0, 0, 0, 0.10)",
  xl: "0 8px 24px rgba(0, 0, 0, 0.12)",
} as const;

// 全局 z-index 分层（见 docs/decisions/KB-EDITOR-ROUND-5.md §2.5）
// 两段：画布容器内部层（portal 进 .kb-canvas-wrap，彼此比拼，必须 <800）；
//       应用浮层（必须 createPortal 到 document.body，≥800）。
// 约定：禁止给布局容器加 transform/filter/will-change；新增浮层禁止裸 z-[数字]，必须用 token。
export const zIndex = {
  base: 0,
  raised: 10,

  // —— 画布容器内部层（portal 进 .kb-canvas-wrap，互不与应用层比拼，必须 <800）——
  // 画布"常驻入口"：左上角关联入口等固定工具位。低于一切内容浮层（关联块 60 起），
  // 让位于用户内容；恒高于 plait svg 本体。
  canvasEntry: 50,
  canvasBlock: 60,
  canvasBadge: 65,
  canvasCard: 68,
  canvasBar: 70,
  canvasPopover: 72,
  // 画布"常驻 chrome"：drawnix 自带的顶部主工具条/缩放条/主题条。
  // 必须高于一切可被用户重排/插入的内容浮层（关联文档卡、节点样式条、设置弹层，≤72），
  // 这样任何关联画布/文档卡片都永不遮挡顶部工具条；嵌套时每个 .kb-canvas-wrap 各自成立。
  canvasChrome: 75,

  // —— 应用浮层（必须 createPortal 到 document.body）——
  drawer: 400,
  modal: 800,
  canvasModal: 820,
  popover: 900,
  toast: 1000,

  // —— 旧键保留兼容（grep 无引用，勿用于新代码）——
  sticky: 100,
  overlay: 500,
} as const;