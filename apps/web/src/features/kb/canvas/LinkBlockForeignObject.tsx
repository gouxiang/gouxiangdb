// apps/web/src/features/kb/canvas/LinkBlockForeignObject.tsx
// 关联块（gxLinkRef geometry）的统一层级渲染容器。
//
// 为什么需要它（层级 bug 的根因与修法）：
//   普通图形（geometry/line/mind/image/text）都是 plait 原子 <svg class="board-host-svg">
//   内 .element-host 中按 board.children 文档顺序绘制的 <g>；而关联块的可视卡片此前渲染在
//   增强 overlay 里，是一张独立的、固定 z-index:60 的 positioned HTML 卡。Chromium 对 SVG
//   内部 <g> 的 position 计算为 static、z-index 不生效（已实测），因此任何单个 <g> 都无法
//   穿出原子 SVG 与外部 HTML 卡按 z-index 交错——Transforms.moveToTop 只重排 SVG 内 <g>
//   顺序，普通图形永远压不过固定 z60 的卡片，表现为"正方形置于顶层仍在关联画布之下"。
//
//   关联块在数据层本就是一个普通 geometry rectangle（带 gxLinkRef 字段），它在 SVG 里本就有
//   自己的 <g>。本组件把卡片通过 React portal + SVG foreignObject 挂进【该元素 <g> 的同层、
//   紧跟其后的位置】（.element-host 下 geomG.nextSibling）：卡片就此成为 SVG 文档绘制序列的
//   一部分，与普通图形共用 board.children 这唯一层级真源。
//   已实测：plait 重排（move_node）时整体移动的是元素的 containerG（mountOnItemMove），
//   MutationObserver 守持会把 foreignObject 重新插到该 <g> 之后；set_node 重绘只更新 <g> 内
//   的矩形、<g> 不重建，注入内容存活。于是置于顶层/底层/上移/下移对"普通图形 vs 关联卡"
//   天然统一生效。
//
//   为什么【不】挂进 g[plait-geometry] 内部（2026-09-12 Safari/WebKit 实测，T4/T7/T9 对照）：
//   WebKit（Safari 17+/Playwright WebKit 26.5 同复现）对位于 g[plait-geometry] 子树内的
//   foreignObject HTML 内容不做栅格化——FO 盒子（几何/内联背景色）在，内部标题/正文/按钮
//   全部空白；DOM、getBoundingClientRect、computed style 全部正常，reflow / 重插 inner /
//   translateZ / 改 FO 宽高属性均无效，也没有任何 clip-path/mask。同一页面里 FO 作为
//   .element-host 的直接子元素（紧跟 geomG）则在 WebKit 与 Chromium 下都完整渲染。
//   Chromium 对两种挂法都正常，故挂同层只影响 WebKit、修好了 Safari。
//
// 命名空间要点：
//   不能把 children 直接 portal 进 foreignObject（SVG 命名空间），否则 React 会把 div 按 SVG
//   命名空间创建而渲染失败。正确做法是先在 foreignObject 内【显式】创建一个 HTML 命名空间的
//   包裹 div，再把 children portal 进该 HTMLDivElement，React 据此把子树按 HTML 渲染。
//
// 事件隔离（为什么不在这里 stopPropagation）：
//   React18 合成事件委托在应用根容器（冒泡阶段），而 plait 的 pointerdown 监听挂在更内层的
//   svg 上、先于根容器触发。若在卡片根用【原生】stopPropagation，事件到不了 React 根，卡片
//   内按钮/拖拽的 React onClick/onPointerDown 会一并失效。因此隔离不放在 DOM，而在
//   DrawnixCanvas.afterInit 中【包装 board 事件方法】：当事件 target 落在 [data-gx-link-fo]
//   内时跳过外层板的 pointerDown/dblClick/keyDown，并用捕获监听阻断 wheel/contextmenu。
//   这样既挡住外层板手势，又完整保留卡片自身的 React 事件与内嵌体交互。
//
// 嵌套隔离：
//   外层主工具条(.draw-toolbar 等)是 wrap 的直接 positioned 子元素(z75)，与 svg 互为兄弟；
//   卡片内嵌子画布即使其工具条 z75，也被关在本 foreignObject 建立的堆叠边界内，无法越过 svg
//   去压外层主工具条（已实测）。生产中内嵌体是只读板，工具条本就被 CSS 隐藏。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PlaitBoard } from "@plait/core";

const SVG_NS = "http://www.w3.org/2000/svg";

/** 在 board 的宿主容器内按元素 id 定位 plait 为该元素创建的容器 <g>。 */
function findElementG(board: PlaitBoard, elementId: string): SVGGElement | null {
  try {
    const host = PlaitBoard.getHost(board) as SVGSVGElement | null;
    return host?.querySelector?.(`g[plait-data-id="${CSS.escape(elementId)}"]`) ?? null;
  } catch {
    return null;
  }
}

export interface LinkBlockForeignObjectProps {
  board: PlaitBoard;
  /** 关联块元素 id（plait-data-id）；<g> 按此定位，不依赖可能变化的元素引用 */
  elementId: string;
  /** viewBox 坐标与尺寸（foreignObject 自动随 svg 视口变换缩放，无需乘 zoom） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 拖拽中：高亮（视觉类名加到 HTML 包裹层） */
  dragging: boolean;
  /** 卡片双击跳转（在 HTML 包裹层上以 React 事件响应，事件不经过 plait 手势） */
  onDoubleClick?: (e: React.MouseEvent) => void;
  children: ReactNode;
}

export function LinkBlockForeignObject({
  board,
  elementId,
  x,
  y,
  width,
  height,
  dragging,
  onDoubleClick,
  children,
}: LinkBlockForeignObjectProps) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const foRef = useRef<SVGForeignObjectElement | null>(null);
  // WebKit 白卡修复：承载 FO 的补偿 g，随 viewBox 原点平移（见挂载 effect 说明）
  const compGRef = useRef<SVGGElement | null>(null);
  // 最新卡片几何（viewBox 坐标），供 rAF 补偿循环读取最新值而无需重跑 effect
  const posRef = useRef({ x: 0, y: 0 });
  // 保存最新的双击回调，供 imperative 绑定的原生监听器调用（避免反复解绑）
  const dblRef = useRef(onDoubleClick);
  dblRef.current = onDoubleClick;

  // 创建 foreignObject + HTML 包裹 div，并【持续保证】它挂在该元素当前的容器 <g> 上。
  //
  // 为什么必须用 MutationObserver 守持，而不是只在挂载时 append 一次：
  //   置于顶层/底层/上移/下移走 plait 的 ZIndexTransforms（move_node），插入/删除节点、undo/redo、
  //   主题切换等也会让 plait 重排甚至重建元素的 containerG。实测重排瞬间 plait 会把受影响元素的
  //   <g> 从 .element-host 摘除再按新顺序插回（部分路径是销毁重建 g），手动 append 进旧 g 的
  //   foreignObject 会随旧 g 一起被摘除。本 effect 只依赖 [board, elementId]，元素 id 不变就不会
  //   重跑，于是卡片永久变成"只剩底层矩形描边/空框"（关联内容消失）。
  //
  //   修法：FO + inner 只创建一次（inner 是 createPortal 的容器，React 子树挂在它里面），随后用
  //   MutationObserver 监听宿主 svg 的子树变化；一旦发现 FO 脱离了该元素当前的 <g>（被摘除或 g
  //   被重建），立即把同一个 FO 重新 append 回当前 g —— inner 与其内 React 子树原样保留，卡片
  //   不丢内容。g 暂时缺失（重建间隙）时退回 rAF 轮询，直到 g 重新出现。
  useEffect(() => {
    let cancelled = false;
    let observer: MutationObserver | null = null;

    const onDbl = (e: MouseEvent) => dblRef.current?.(e as unknown as React.MouseEvent);
    // wheel 必须在 DOM 层阻断冒泡：plait 的滚轮缩放/平移是绑在 viewport-container 的【原生】
    // 监听（非板方法），无法用包装板方法拦截。卡片内嵌只读子画布的滚轮在内嵌容器（本 host 的
    // 后代）先处理，冒泡到这里时阻断，避免继续冒泡到外层板 viewport-container 带动外层缩放/平移。
    // 只阻断冒泡、不 preventDefault，卡片自身没有 onWheel 需求，故不影响卡片按钮/内嵌体交互。
    const onWheel = (e: WheelEvent) => e.stopPropagation();

    // FO 与 inner 只创建一次，重挂时复用（保住 portal 子树与已加载内容）。
    const fo = document.createElementNS(SVG_NS, "foreignObject") as SVGForeignObjectElement;
    fo.setAttribute("data-gx-link-fo", "1");
    // 记录所属元素 id：FO 被摘到别处时，右键选中仍能据 data-gx-element-id 定位回关联块
    fo.setAttribute("data-gx-element-id", elementId);
    const inner = document.createElement("div");
    inner.style.width = "100%";
    inner.style.height = "100%";
    inner.addEventListener("dblclick", onDbl);
    inner.addEventListener("wheel", onWheel);
    fo.appendChild(inner);
    foRef.current = fo;

    // 【Safari/WebKit 白卡修复】补偿 g。
    // WebKit 实测：当 svg viewBox 原点为负（plait 平移后的常态，如 -1673,-937）时，
    // 位于负坐标区的 foreignObject 内部复杂 HTML（flex/百分比高度卡片）整体不栅格化——
    // FO 盒子/边框在、内部全白；无报错，reflow/detach/opacity/overflow 等运行时手段
    // 均无法恢复（1:1 复刻 W1-W4、Z1-Z4、T1-T4 对照确认；Chromium 无此问题）。
    // 修法：FO 不直接挂 element-host，而挂进本组件持有的补偿 g：
    //   g.transform = translate(vbOriginX, vbOriginY)
    //   FO.x/y = 卡片viewBox坐标 - vbOrigin   （卡片在可见区时恒为非负，绕开裁剪）
    // 最终绘制位置 = g 平移 + FO 坐标 = 原卡片 viewBox 坐标，与缩放/滚动无关。
    const compG = document.createElementNS(SVG_NS, "g") as SVGGElement;
    compG.setAttribute("data-gx-link-comp", "1");
    compG.setAttribute("data-gx-element-id", elementId);
    compG.appendChild(fo);
    compGRef.current = compG;

    // 把补偿 g 挂到该元素容器 g 的【同层、紧随其后】位置；返回是否成功（g 尚不存在则 false）。
    // 不能 append 进 geomG 内部：WebKit 下 g[plait-geometry] 子树内的 FO 同样不栅格化。
    const attach = (): boolean => {
      if (cancelled) return true; // 已卸载，停止轮询
      const geomG = findElementG(board, elementId);
      const parent = geomG?.parentElement;
      if (!geomG || !parent) return false;
      if (compG.parentNode !== parent || geomG.nextSibling !== compG) {
        parent.insertBefore(compG, geomG.nextSibling);
      }
      return true;
    };

    const poll = () => {
      if (cancelled) return;
      if (!attach()) rafRef.current = requestAnimationFrame(poll);
    };

    // 初次挂载；g 一般初始化即存在，缺失则 rAF 兜底。
    if (!attach()) rafRef.current = requestAnimationFrame(poll);
    setHost(inner);

    // 按当前 svg viewBox 原点同步补偿变换与 FO 坐标（WebKit 白卡修复的核心）。
    const syncComp = () => {
      const svg = PlaitBoard.getHost(board) as SVGSVGElement | null;
      const vb = svg?.getAttribute?.("viewBox");
      const parts = vb?.split(/[\s,]+/);
      const ox = Number(parts?.[0]) || 0;
      const oy = Number(parts?.[1]) || 0;
      compG.setAttribute("transform", `translate(${ox} ${oy})`);
      const p = posRef.current;
      fo.setAttribute("x", String(Math.round(p.x - ox)));
      fo.setAttribute("y", String(Math.round(p.y - oy)));
    };
    syncComp();

    // 守持：plait 重排/重建导致补偿 g 脱离当前位置时，下一帧内重挂；
    // viewBox 原点变化（缩放/平移）时同步补偿变换。
    // C-8：回调 rAF 合帧——subtree 监听在拖拽/重排时突变批次极密，
    // 每个批次同步 findElementG 是 O(FO数×突变数) 风暴；合帧后每帧每 FO 最多检查一次。
    let checkScheduled = false;
    const hostSvg = PlaitBoard.getHost(board) as SVGSVGElement | null;
    if (hostSvg) {
      observer = new MutationObserver((mutations) => {
        if (cancelled || checkScheduled) return;
        const vbChanged = mutations.some(
          (m) => m.type === "attributes" && m.attributeName === "viewBox",
        );
        checkScheduled = true;
        requestAnimationFrame(() => {
          checkScheduled = false;
          if (cancelled) return;
          if (vbChanged) syncComp();
          const geomG = findElementG(board, elementId);
          if (!geomG || !geomG.parentElement) {
            // g 重建间隙：交给 rAF 等待新 g
            cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(poll);
            return;
          }
          const parent = geomG.parentElement;
          if (compG.parentNode !== parent || geomG.nextSibling !== compG) {
            parent.insertBefore(compG, geomG.nextSibling);
          }
        });
      });
      observer.observe(hostSvg, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["viewBox"],
      });
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      observer?.disconnect();
      inner.removeEventListener("dblclick", onDbl);
      inner.removeEventListener("wheel", onWheel);
      // 补偿 g（含 foreignObject）由本组件全权拥有，卸载时整体移除（plait 只画它自己的矩形）
      compG.remove();
      compGRef.current = null;
      foRef.current = null;
    };
  }, [board, elementId]);

  // 同步几何（viewBox 单位）。每次渲染都写一次，覆盖 move_node 后 plait 可能的属性重置。
  // x/y 仅记录最新卡片位置；真正写 FO 属性时减去 viewBox 原点（见 syncComp，WebKit 修复）。
  useEffect(() => {
    posRef.current = { x, y };
    const foEl = foRef.current;
    if (!foEl) return;
    // 宽高不受原点补偿影响
    foEl.setAttribute("width", String(Math.round(width)));
    foEl.setAttribute("height", String(Math.round(height)));
    // 立即按当前 viewBox 原点补一次坐标（不必等下一帧 rAF）
    const svg = PlaitBoard.getHost(board) as SVGSVGElement | null;
    const vb = svg?.getAttribute?.("viewBox");
    const parts = vb?.split(/[\s,]+/);
    const ox = Number(parts?.[0]) || 0;
    const oy = Number(parts?.[1]) || 0;
    const compG = compGRef.current;
    if (compG) compG.setAttribute("transform", `translate(${ox} ${oy})`);
    foEl.setAttribute("x", String(Math.round(x - ox)));
    foEl.setAttribute("y", String(Math.round(y - oy)));
  });

  // 注意：拖拽时【不】把 foreignObject 移到 element-top-host 之类的高绘制带。曾尝试在拖拽中
  // appendChild 抬升 FO 以临时置顶，但这会把已 setPointerCapture 的 header 节点移出原位置，
  // 导致 pointerup 丢失、拖拽无法结束（FO 滞留在 top-host、data-dragging 不清）。SVG 内又无法
  // 用 z-index 临时置顶。故拖拽期保持其持久绘制位置（=board.children 顺序），仅做高亮——这与
  // plait 原生拖拽语义一致：被拖对象本就在自己的 g 序列里，不临时穿越其它元素的层级。

  // 包裹层视觉：拖拽态高亮。gx-link-block 保留 box-shadow 过渡/hover 语义。
  useEffect(() => {
    if (!host) return;
    host.className = `gx-link-block flex h-full w-full flex-col overflow-hidden rounded-gx-md border bg-gx-surface ${
      dragging
        ? "border-gx-accent shadow-2xl ring-2 ring-gx-accent/40"
        : "border-gx-separator shadow-lg"
    }`;
    host.setAttribute("data-gx-link-block", "true");
    host.setAttribute("data-dragging", dragging ? "true" : "false");
  }, [host, dragging]);

  if (!host) return null;
  return createPortal(children, host);
}
