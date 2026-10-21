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
  // —— 既有四档（黑灰投影）：键值不动，旧类名 shadow-gx-sm/md/lg/xl 零视觉回归 ——
  sm: "0 1px 2px rgba(0, 0, 0, 0.04)",
  md: "0 2px 6px rgba(0, 0, 0, 0.08)",
  lg: "0 4px 12px rgba(0, 0, 0, 0.10)",
  xl: "0 8px 24px rgba(0, 0, 0, 0.12)",

  // —— v6 底板新增档（墨色冷调，逐字取自 v6/src/shared.css :root）——
  // 卡片：极轻双层投影（--sh-card）
  card: "0 1px 2px rgba(16, 24, 40, .04), 0 1px 3px rgba(16, 24, 40, .05)",
  // 弹层/浮起：--sh-pop
  pop: "0 10px 28px -10px rgba(16, 24, 40, .18), 0 2px 6px rgba(16, 24, 40, .06)",
  // 拟物三态（L1 图标砖）：凸起 / 悬停上浮 / 选中按下凹槽（--sh-raise / -hi / -press）
  raise:
    "0 1px 1px rgba(16, 24, 40, .06), 0 2px 5px -1px rgba(16, 24, 40, .10), inset 0 1px 0 rgba(255, 255, 255, .95)",
  raiseHi:
    "0 2px 4px rgba(16, 24, 40, .08), 0 7px 15px -4px rgba(16, 24, 40, .20), inset 0 1px 0 rgba(255, 255, 255, .95)",
  press:
    "inset 0 1px 3px rgba(16, 24, 40, .16), inset 0 -1px 0 rgba(255, 255, 255, .70)",
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
  // 「弹窗之上再弹窗」：确认弹窗（confirmAction 宿主）必须盖在画布/文档编辑弹窗
  // （canvasModal 820）之上 —— 否则关编辑弹窗时的二次确认被编辑弹窗整个挡住（P0-④a）。
  // 修法是抬高确认层，不调低 canvas-modal（画布编辑窗本来就该压住页面内容）。
  modalNested: 860,
  popover: 900,
  toast: 1000,

  // —— 旧键保留兼容（grep 无引用，勿用于新代码）——
  sticky: 100,
  overlay: 500,
} as const;