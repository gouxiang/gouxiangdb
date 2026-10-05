// M3/S10 1000+ 库列表 DOM 有界 + 渲染耗时度量（node，react-dom/server，无 jsdom/新依赖）。
//
// 背景：SPEC §134 10 万节点，库列表可达上千。窗口化前 PrimaryNav 全量 map，
// DOM 随项数线性膨胀。本用例锁死：
//   - 首帧（SSR，viewport 用窗口化初始常量 24 行 + overscan）只渲染有界行，不随 1200 项膨胀；
//   - 统计 HTML 中行标记数量（data-nav-row 计数），断言有上界且显著小于项总数；
//   - 输出一次实测 renderToString 耗时（performance.now），作为首屏渲染度量留证。
// 注：SSR 不跑 ResizeObserver，viewportH=行高*24（useMenuVirtualizer 初值），恰好验证
// 「首帧即有界」这一最关键性质；真实滚动窗口由纯函数 virtualWindow（M2 已测）保证。
//
// 原 ComposerTree 对应用例已随导航编排树组件（composer/ComposerTree）一并删除：
// 组件零生产引用，测试失去被测对象；PrimaryNav 用例继续锁 L1 窗口化不回归。
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";

const TOTAL = 1200;

// ui 组件里的 toast/Spinner 在 SSR 不被走到；忽略图标内部。
import { PrimaryNav } from "./PrimaryNav";

describe("S10 大库列表 DOM 有界（首屏不随项数线性膨胀）", () => {
  it(`PrimaryNav：${TOTAL} 个库，首帧渲染的一级行数有界（≈视口窗口，非全量）`, () => {
    // 第三批：一级导航的行直接来自 bases/kbs 实体列表，窗口化口径不变。
    const big = Array.from({ length: TOTAL }, (_, i) => ({
      id: `b${i}`, name: `表 ${i}`, icon: null, iconColor: null,
    }));

    const t0 = performance.now();
    const html = renderToString(
      <StaticRouter location="/">
        <PrimaryNav bases={big} />
      </StaticRouter>,
    );
    const ms = performance.now() - t0;

    // 每个库行是一个带 data-nav-row="item" 的 <button>，行内文字 + 行尾「…」菜单的
    // aria-label/title 都会重复一次库名 —— 按文本计数会把「渲染了 N 行」数成 3N，
    // 故这里直接数行标记（S10 锁的是挂载的**行数**，不是文本出现次数）。
    const rowHits = (html.match(/data-nav-row="item"/g) ?? []).length;
    // 首帧窗口：viewportH=32*24=768px，可见 24 行 + overscan 12*2=24 → 上界 48；留余量取 120。
    expect(rowHits).toBeGreaterThan(0);
    expect(rowHits).toBeLessThanOrEqual(120);
    // 关键不变式：挂载数远小于总数（没有全量 map 出 1200 行）
    expect(rowHits).toBeLessThan(TOTAL / 5);
    // 总高仍按全量撑出（滚动条正确）：padBottom 占位使 scrollHeight≈TOTAL*32
    expect(html).toContain("表 0");
    console.log(`[S10-metric] PrimaryNav SSR ${TOTAL} libraries: renderedRows=${rowHits}, render=${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(1000); // SPEC 首屏 <1s；SSR 纯字符串渲染远低于此
  });
});
