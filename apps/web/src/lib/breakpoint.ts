// 响应式断点档位（UI-SPEC v1.0 R-D-29~R-D-33 五档）。
//
// 为什么需要 JS 档位而不是纯 Tailwind 类：R-D-32 要求「768–1023 表格转卡片列表」、
// R-D-33 要求「<768 L1/L2 全部改为抽屉」——这两种是**结构替换**（DOM 不同，不是一个
// 元素换 class），CSS 类无法表达，故保留一个极窄的 JS 档位判断。
// 除此之外（按钮收溢出菜单、搜索折叠为图标、L2 宽度 208/240）全部走 Tailwind 断点类。
//
// SSR（vitest node 环境无 window）一律回落最宽档 "2xl"：
// 单测断言的是桌面表现，与真机 ≥1440 一致（既有壳层单测依赖这一点）。

import { useEffect, useState } from "react";

/** 五档断点：与 UI-SPEC §3.6 表一一对应。 */
export type BreakpointTier = "sm" | "md" | "lg" | "xl" | "2xl";

/** 各档下界（px）。上界由下一档的下界隐含。 */
export const TIER_MIN_WIDTH: Record<BreakpointTier, number> = {
  sm: 0, // <768（R-D-33）
  md: 768, // 768–1023（R-D-32）
  lg: 1024, // 1024–1279（R-D-31）
  xl: 1280, // 1280–1439（R-D-30）
  "2xl": 1440, // ≥1440（R-D-29）
};

/** 纯函数：宽度 → 档位。便于单测直接覆盖五档边界。 */
export function tierOfWidth(width: number): BreakpointTier {
  if (!Number.isFinite(width) || width < TIER_MIN_WIDTH.md) return "sm";
  if (width < TIER_MIN_WIDTH.lg) return "md";
  if (width < TIER_MIN_WIDTH.xl) return "lg";
  if (width < TIER_MIN_WIDTH["2xl"]) return "xl";
  return "2xl";
}

/** <768：单栏 + 抽屉（R-D-33）。 */
export function isDrawerTier(tier: BreakpointTier): boolean {
  return tier === "sm";
}

/** 768–1279：L2 以「浮出面板」覆盖内容区左侧（R-D-31 / R-D-32）。 */
export function isFloatingL2Tier(tier: BreakpointTier): boolean {
  return tier === "md" || tier === "lg";
}

/**
 * 订阅窗口宽度的档位。resize 时更新；SSR / 无 window 环境恒定返回 "2xl"（桌面）。
 */
export function useBreakpointTier(): BreakpointTier {
  const [tier, setTier] = useState<BreakpointTier>(() =>
    typeof window === "undefined" ? "2xl" : tierOfWidth(window.innerWidth),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setTier((prev) => {
      const next = tierOfWidth(window.innerWidth);
      return next === prev ? prev : next;
    });
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  return tier;
}
