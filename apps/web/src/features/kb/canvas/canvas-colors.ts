// apps/web/src/features/kb/canvas/canvas-colors.ts
// 画布节点样式面板使用的色板（与 Drawnix 自带浮条色板一致的常用色，保证新旧 UI 色彩体系统一）。
// plait 的"无颜色"哨兵是字符串 "NO_COLOR"；透明为 "TRANSPARENT"。

export const NO_COLOR = "NO_COLOR";
export const TRANSPARENT = "TRANSPARENT";

/** 描边/文字色板（含无颜色） */
export const STROKE_COLORS = [
  NO_COLOR,
  "#333333",
  "#808080",
  "#D3D3D3",
  "#FFFFFF",
  "#1E90FF",
  "#00CED1",
  "#2ECC71",
  "#228B22",
  "#FFD700",
  "#FFA500",
  "#FF4500",
  "#FFB3BA",
  "#8A2BE2",
  "#8B4513",
];

/** 填充色板（含无填充透明、白） */
export const FILL_COLORS = [
  TRANSPARENT,
  "#FFFFFF",
  "#F5F5F5",
  "#D3D3D3",
  "#FFF3CD",
  "#FFE8A3",
  "#FFD6A5",
  "#FFB3BA",
  "#F8C8DC",
  "#D0F0C0",
  "#B7E4C7",
  "#CAF0F8",
  "#AEDFF7",
  "#CDB4DB",
  "#E2C6FF",
];

export function normalizeColor(c: string | null | undefined): string | null {
  if (!c || c === NO_COLOR || c === TRANSPARENT) return null;
  return c;
}
