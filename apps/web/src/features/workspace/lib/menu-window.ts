// 变高行的虚拟窗口计算（纯算术，无 DOM / 无 React）。
//
// 背景：L1 菜单精细化后行高不再是单一常量——分组标题 24、菜单项 32，且每行带 2px 行距。
// 继续用 virtualWindow(scrollTop, viewportH, rowH, total) 会按「平均行高」映射滚动位置，
// 累计漂移 = Σ(实际行高 - 常量)，分组标题越多漂得越远，最终窗口切不到真实可见行
// （典型的沉默逻辑错误：不报错，只是滚动到中段时上方出现空白）。
// 故这里按逐行高度做前缀和切片，padTop/padBottom 与真实 DOM 高度逐像素一致。
export interface HeightWindow {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  totalHeight: number;
}

const EMPTY: HeightWindow = { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 };

/**
 * 按逐行高度切片。
 * - heights.length 即总行数；非正/非有限值按 0 处理（脏数据不至于整段白屏）；
 * - overscan 与定高版同义（视口上下各多渲染几行，快速滚动不闪白）；
 * - 与 virtualWindow 同契约：end 为切片右开区间，padTop/padBottom 撑出正确滚动条。
 */
export function virtualWindowByHeights(
  scrollTop: number,
  viewportH: number,
  heights: readonly number[],
  overscan = 8,
): HeightWindow {
  const n = heights.length;
  if (n === 0) return EMPTY;

  const h = new Array<number>(n);
  let totalHeight = 0;
  for (let i = 0; i < n; i++) {
    const v = heights[i]!;
    const safe = Number.isFinite(v) && v > 0 ? v : 0;
    h[i] = safe;
    totalHeight += safe;
  }

  // 视口高度为 0（SSR 首帧之外、容器被折叠）：仍给一个有界窗口，避免整列表不渲染。
  if (viewportH <= 0) {
    return { start: 0, end: Math.min(n, overscan * 2), padTop: 0, padBottom: Math.max(0, totalHeight - sum(h, 0, Math.min(n, overscan * 2))), totalHeight };
  }

  const top = Math.max(0, scrollTop);
  // 第一个底边超过视口顶边的行
  let first = 0;
  let acc = 0;
  while (first < n && acc + h[first]! <= top) {
    acc += h[first]!;
    first++;
  }
  const start = Math.max(0, first - overscan);

  // 从 first 起累计到覆盖视口高度
  let last = first;
  let used = 0;
  while (last < n && used < viewportH) {
    used += h[last]!;
    last++;
  }
  const end = Math.min(n, last + overscan);

  return {
    start,
    end,
    padTop: sum(h, 0, start),
    padBottom: sum(h, end, n),
    totalHeight,
  };
}

function sum(h: readonly number[], from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += h[i]!;
  return s;
}
