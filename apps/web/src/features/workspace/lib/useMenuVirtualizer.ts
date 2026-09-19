// M3/S10 菜单树窗口化：滚动容器只挂载视口附近的行（定高行），DOM 节点数不随菜单总量线性膨胀。
// 复用 M2 通讯录同一套纯函数 virtualWindow（contacts/lib/tree），口径一致、零新依赖。
//
// 设计：
//  - 行高固定（ComposerTree 31），用留白撑出总高，滚动位置映射行号；
//  - viewport 初值给保守常量，SSR/首帧即只渲染有界行数；ResizeObserver 挂载后修正为真实高度；
//  - expandedIds 变化（容器折叠）只影响输入行数，窗口切片逻辑不变。
//
// 变高分支：L1 菜单精细化后行高不再单一（分组标题 24 / 菜单项 32，各带 2px 行距），
// 传 rowHeights 即走 virtualWindowByHeights（逐行前缀和），定高调用点（ComposerTree）
// 不受影响——不传就完全走原路径。
import { useEffect, useRef, useState } from "react";
import { virtualWindow } from "../../contacts/lib/tree";
import { virtualWindowByHeights } from "./menu-window";

export interface MenuVirtualizer<T> {
  scrollerRef: React.RefObject<HTMLDivElement>;
  /** 当前窗口内应渲染的行（已切片）。 */
  windowed: T[];
  /** 窗口首行在全量行中的下标（key 用）。 */
  startIndex: number;
  /** 顶部/底部占位高度（px），撑出与全量列表一致的滚动条。 */
  padTop: number;
  padBottom: number;
}

export function useMenuVirtualizer<T>(
  rows: readonly T[],
  rowH: number,
  overscan = 12,
  /** 逐行高度（含行距）。给了就按变高切片，不给则按 rowH 定高切片。 */
  rowHeights?: readonly number[],
): MenuVirtualizer<T> {
  const scrollerRef = useRef<HTMLDivElement>(null);
  // 初值按「约 24 行可视」给，保证首帧/SSR 即有界；真实高度由 ResizeObserver 回填。
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(rowH * 24);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  const win =
    rowHeights && rowHeights.length === rows.length
      ? virtualWindowByHeights(scrollTop, viewportH, rowHeights, overscan)
      : virtualWindow(scrollTop, viewportH, rowH, rows.length, overscan);
  return {
    scrollerRef,
    windowed: rows.slice(win.start, win.end) as T[],
    startIndex: win.start,
    padTop: win.padTop,
    padBottom: win.padBottom,
  };
}
