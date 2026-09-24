// packages/design-tokens/src/tailwind.ts
// 把 design tokens 映射为 Tailwind 配置
// 让 v2 前端 Tailwind 与 v1 GXTheme 视觉完全一致

import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import { colors, spacing, radius, fontSize, fontWeight, shadow, zIndex } from "./index.js";

export const gxTailwindConfig: Partial<Config> = {
  theme: {
    extend: {
      // 显式断点，与 apps/web/src/lib/breakpoint.ts 的 JS 档位对齐：
      // 2xl=1440（此前未声明，走 Tailwind 默认 1536，导致 1440–1535 区间 CSS/JS 口径不一致）。
      // 放在 extend.screens：与默认 screens 浅合并，五键齐全即整体覆盖默认值。
      screens: {
        sm: "640px",
        md: "768px",
        lg: "1024px",
        xl: "1280px",
        "2xl": "1440px",
      },
      colors: {
        gx: {
          accent: colors.accent,
          "accent-bg": colors.accentBg,
          "accent-hover": colors.accentHover,
          selected: colors.selected,
          "text-primary": colors.textPrimary,
          "text-secondary": colors.textSecondary,
          "text-tertiary": colors.textTertiary,
          "text-hint": colors.textHint,
          "text-faint": colors.textFaint,
          bg: colors.bg,
          nav1: colors.nav1,
          nav2: colors.nav2,
          surface: colors.surface,
          "table-header": colors.tableHeader,
          control: colors.control,
          hover: colors.hover,
          "row-hover": colors.rowHover,
          hairline: colors.hairline,
          border: colors.border,
          "border-strong": colors.borderStrong,
          "divider-v": colors.dividerV,
          "logo-block": colors.logoBlock,
          "avatar-sample": colors.avatarSample,
          success: colors.success,
          "success-bg": colors.successBg,
          warning: colors.warning,
          "warning-bg": colors.warningBg,
          danger: colors.danger,
          "danger-bg": colors.dangerBg,
          // —— v1 遗留，附录 A 未列，保留供旧类名使用（去留由后续切片决定）——
          "card-bg": colors.cardBg,
          zebra: colors.zebra,
          separator: colors.separator,
          "header-edge": colors.headerEdge,
        },
      },
      boxShadow: {
        "gx-sm": shadow.sm,
        "gx-md": shadow.md,
        "gx-lg": shadow.lg,
        "gx-xl": shadow.xl,
      },
      spacing: {
        "gx-xxs": `${spacing.xxs}px`,
        "gx-xs": `${spacing.xs}px`,
        "gx-sm": `${spacing.sm}px`,
        "gx-md": `${spacing.md}px`,
        "gx-lg": `${spacing.lg}px`,
        "gx-xl": `${spacing.xl}px`,
        "gx-xxl": `${spacing.xxl}px`,
        "gx-3xl": `${spacing["3xl"]}px`,
        "gx-4xl": `${spacing["4xl"]}px`,
        "gx-5xl": `${spacing["5xl"]}px`,
        "gx-6xl": `${spacing["6xl"]}px`,
      },
      borderRadius: {
        "gx-sm": `${radius.sm}px`,
        "gx-md": `${radius.md}px`,
        "gx-lg": `${radius.lg}px`,
        "gx-xl": `${radius.xl}px`,
        "gx-2xl": `${radius["2xl"]}px`,
        "gx-3xl": `${radius["3xl"]}px`,
      },
      fontSize: {
        "gx-11": [`${fontSize.x11}px`, { lineHeight: "1.5" }],
        "gx-12": [`${fontSize.x12}px`, { lineHeight: "1.5" }],
        "gx-13": [`${fontSize.x13}px`, { lineHeight: "1.5" }],
        "gx-14": [`${fontSize.x14}px`, { lineHeight: "1.5" }],
        // R-D-02 / A.2：九档字号含 15，行高按「11–16 → 1.5」绑定
        "gx-15": [`${fontSize.x15}px`, { lineHeight: "1.5" }],
        "gx-16": [`${fontSize.x16}px`, { lineHeight: "1.5" }],
        "gx-18": [`${fontSize.x18}px`, { lineHeight: "1.4" }],
        "gx-20": [`${fontSize.x20}px`, { lineHeight: "1.4" }],
        "gx-24": [`${fontSize.x24}px`, { lineHeight: "1.3" }],
      },
      fontWeight: {
        regular: `${fontWeight.regular}`,
        medium: `${fontWeight.medium}`,
        semibold: `${fontWeight.semibold}`,
        bold: `${fontWeight.bold}`,
      },
      // 全局 z-index 分层（layout.ts zIndex），统一 gx-z- 前缀避免与 Tailwind 默认 z-* 冲突
      zIndex: {
        // 画布容器内部层（<800）
        "gx-z-canvas-entry": String(zIndex.canvasEntry),
        "gx-z-canvas-block": String(zIndex.canvasBlock),
        "gx-z-canvas-badge": String(zIndex.canvasBadge),
        "gx-z-canvas-card": String(zIndex.canvasCard),
        "gx-z-canvas-bar": String(zIndex.canvasBar),
        "gx-z-canvas-popover": String(zIndex.canvasPopover),
        "gx-z-canvas-chrome": String(zIndex.canvasChrome),
        // 应用浮层（portal 到 body）
        "gx-z-drawer": String(zIndex.drawer),
        "gx-z-modal": String(zIndex.modal),
        "gx-z-canvas-modal": String(zIndex.canvasModal),
        "gx-z-modal-nested": String(zIndex.modalNested),
        "gx-z-popover": String(zIndex.popover),
        "gx-z-toast": String(zIndex.toast),
      },
    },
  },
  // theme.extend.zIndex 的键会生成 `.z-gx-z-modal` 这类工具名（Tailwind 固定 z- 前缀），
  // 而源码按分层契约直接使用 `.gx-z-modal`，故再用 plugin 以同名 utility 注册，JIT 才会生成。
  plugins: [
    plugin(({ addUtilities }) => {
      addUtilities({
        ".gx-z-canvas-block": { zIndex: String(zIndex.canvasBlock) },
        ".gx-z-canvas-badge": { zIndex: String(zIndex.canvasBadge) },
        ".gx-z-canvas-card": { zIndex: String(zIndex.canvasCard) },
        ".gx-z-canvas-bar": { zIndex: String(zIndex.canvasBar) },
        ".gx-z-canvas-popover": { zIndex: String(zIndex.canvasPopover) },
        ".gx-z-drawer": { zIndex: String(zIndex.drawer) },
        ".gx-z-modal": { zIndex: String(zIndex.modal) },
        ".gx-z-canvas-modal": { zIndex: String(zIndex.canvasModal) },
        ".gx-z-modal-nested": { zIndex: String(zIndex.modalNested) },
        ".gx-z-popover": { zIndex: String(zIndex.popover) },
        ".gx-z-toast": { zIndex: String(zIndex.toast) },
      });
    }),
  ],
};