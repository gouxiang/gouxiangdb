// apps/web/src/features/kb/DrawnixCanvas.tsx
// Drawnix 画布封装：把开源 Drawnix 编辑器以"插件式"接入，保存完全由我方接管
// （onValueChange 防抖 → useDocPersistence → KbApi.saveContent），不使用组件库自带的"保存为 .drawnix 文件"。
//
// 关键设计（修复"无法添加节点/无法编辑文字"）：
//  1. 样式必须按顺序加载三层：@plait-board/react-board 核心布局（.plait-board-container /
//     .viewport-container / foreignObject 文字编辑框）→ @plait-board/react-text 文字编辑
//     → @drawnix/drawnix 工具栏皮肤。缺核心层会导致画板容器尺寸塌陷、slate 编辑框不可用。
//     这三个包的 package.json 都没暴露 ./index.css 子路径（严格 ESM 无法 import），
//     故 vendored 到 ./vendor/（版本随锁文件固定）。
//  2. 非受控：value 只在首次挂载传入一个稳定引用，之后绝不回灌——Drawnix 内部自管 board 状态，
//     回灌会打断正在进行的拖拽/文字输入。外部内容整体替换（回滚/切换文档/打开版本）由父级
//     用 `key` 重挂载整个组件实现。
//  3. 只读：afterInit 拿到 PlaitBoard 实例后设置只读；不使用遮罩（遮罩会连平移/缩放一起拦死）。
// 动态 import，避免 Drawnix 的浏览器依赖进入首屏与 SSR 路径。

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { BoardTransforms } from "@plait/core";
import {
  CanvasBoardProvider,
  type CanvasEnhanceContextValue,
  type CanvasRuntimeHandles,
} from "./canvas/canvas-context";
import { CanvasEnhanceOverlay } from "./canvas/CanvasEnhanceOverlay";
import { installLinkBoardGuards, installPreviewBoardGuards } from "./canvas/board-guards";
import { fitViewportWhenReady, isDataMutatingOp } from "./canvas/readonly-preview";

// 顺序很重要：核心布局 → 文字编辑 → drawnix 皮肤
import "./vendor/plait-board.css";
import "./vendor/plait-text.css";
import "./vendor/drawnix.css";
import "./kb.css";

type PlaitElement = Record<string, unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type DrawnixType = React.ComponentType<any>;

export interface DrawnixCanvasProps {
  /** 画布 JSON 字符串（doc.content）；仅在挂载时读取，变更请用 key 重挂载 */
  content: string | undefined;
  /** 内容变更回调：每次编辑同步上抛（防抖/保存由父级接管，保证手动保存拿到最新值） */
  onContentChange?: (json: string) => void;
  /** 云端保存回调：Cmd/Ctrl+S 时触发（统一走云端，不使用 Drawnix 自带的文件下载） */
  onSave?: () => void | Promise<void>;
  readonly?: boolean;
  /**
   * 只读但允许查看交互（平移/滚轮缩放/触控板）。
   * 用于文档内嵌入预览：不盖全屏 pointer 遮罩。
   * 历史版本快照等"完全不可交互"场景保持默认 false（盖遮罩）。
   */
  allowViewInteraction?: boolean;
  /** viewport 变化（缩放/平移）回调，供外层同步缩放比例显示 */
  onViewportChange?: (viewport: { zoom?: number; origination?: [number, number] }) => void;
  /** 挂载并初始化完成后自动适配内容全貌（只读预览场景，让用户第一眼看到整张画布） */
  fitOnLoad?: boolean;
  /**
   * 启用画布增强层（节点样式面板/注释/关联文档等）。传入即启用；只读板应不传。
   * kbId/publicToken/canEdit 决定增强 UI 的数据通道与可见性。
   */
  enhance?: CanvasEnhanceContextValue;
}

function safeParse(json: string | undefined): PlaitElement[] {
  if (!json || !json.trim()) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as PlaitElement[]) : [];
  } catch {
    return [];
  }
}

/**
 * 板级事件守卫（编辑态的关联卡守卫 / 只读预览的整体短路）已抽到 ./canvas/board-guards：
 *   - 编辑态  installLinkBoardGuards：只跳过落在关联卡 [data-gx-link-fo] 内的板手势；
 *   - 只读预览 installPreviewBoardGuards：跳过全部板手势，杜绝选区/拖拽态残留成"残影"（P0-②）。
 * 两者都是纯函数，单测见 board-guards.test.ts。
 */

/** 外部命令式控制句柄：供版本预览等只读场景的工具条驱动缩放/适配，无需自行操作 board */
export interface DrawnixCanvasHandle {
  /** 放大 / 缩小（步进 0.1，plait 内部自动夹紧到 MIN/MAX_ZOOM） */
  zoomBy: (delta: number) => void;
  /** 设置到指定比例（1 = 100%） */
  setZoom: (zoom: number) => void;
  /** 适配内容到可视区全貌 */
  fit: () => void;
  /** 当前缩放比例 */
  getZoom: () => number;
  /** F1: 相对当前 origination 平移（CSS 像素，缩放后保持手感一致） */
  panBy: (dx: number, dy: number) => void;
  /** F1: 直接设置 origination（viewBox 坐标） */
  setOrigination: (x: number, y: number) => void;
  /** F1: 获取当前 origination */
  getOrigination: () => [number, number];
}

export const DrawnixCanvas = forwardRef<DrawnixCanvasHandle, DrawnixCanvasProps>(function DrawnixCanvas(
  {
    content,
    onContentChange,
    onSave,
    readonly = false,
    allowViewInteraction = false,
    onViewportChange,
    fitOnLoad = false,
    enhance,
  },
  ref,
) {
  const [Comp, setComp] = useState<DrawnixType | null>(null);
  const boardRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [board, setBoard] = useState<any>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const handlesRef = useRef<CanvasRuntimeHandles | null>(null);
  const readonlyRef = useRef(readonly);
  readonlyRef.current = readonly;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onViewportRef = useRef(onViewportChange);
  onViewportRef.current = onViewportChange;
  const fitOnLoadRef = useRef(fitOnLoad);
  fitOnLoadRef.current = fitOnLoad;
  /** 首帧适配的重试/监听取消句柄（见 canvas/readonly-preview.ts） */
  const cancelFitRef = useRef<(() => void) | null>(null);
  const lastEmitted = useRef<string>(content ?? "");

  // 卸载/重挂载时收掉首帧适配的 rAF 轮询与 ResizeObserver（预览卡频繁挂载卸载，不留悬挂监听）
  useEffect(() => () => cancelFitRef.current?.(), []);

  // 命令式缩放控制：经 BoardTransforms 作用于真实 board（只读时也可用，viewport 是视图态不改数据、不进撤销栈）
  useImperativeHandle(
    ref,
    () => ({
      zoomBy: (delta: number) => {
        const b = boardRef.current;
        if (!b?.viewport) return;
        BoardTransforms.updateZoom(b, b.viewport.zoom + delta);
      },
      setZoom: (zoom: number) => {
        const b = boardRef.current;
        if (!b?.viewport) return;
        BoardTransforms.updateZoom(b, zoom);
      },
      fit: () => {
        const b = boardRef.current;
        if (!b) return;
        BoardTransforms.fitViewport(b);
      },
      getZoom: () => boardRef.current?.viewport?.zoom ?? 1,
      // F1: 平移——dx/dy 为 CSS 像素，除以 zoom 换算到 viewBox 坐标系（保持缩放下手感一致）
      panBy: (dx: number, dy: number) => {
        const b = boardRef.current;
        if (!b?.viewport) return;
        const z = b.viewport.zoom || 1;
        const cur = b.viewport.origination;
        BoardTransforms.updateViewport(b, [cur[0] + dx / z, cur[1] + dy / z]);
      },
      setOrigination: (x: number, y: number) => {
        const b = boardRef.current;
        if (!b?.viewport) return;
        BoardTransforms.updateViewport(b, [x, y]);
      },
      getOrigination: () => {
        const b = boardRef.current;
        return b?.viewport?.origination ?? [0, 0];
      },
    }),
    [],
  );

  // 初始值只解析一次，保持引用稳定（非受控）
  const initialValue = useMemo<PlaitElement[]>(() => safeParse(content), []); // eslint-disable-line react-hooks/exhaustive-deps

  // 动态加载 Drawnix（仅浏览器端）
  useEffect(() => {
    let alive = true;
    void import("@drawnix/drawnix").then((mod: any) => {
      if (alive && mod.Drawnix) setComp(() => mod.Drawnix as DrawnixType);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 只读预览但允许查看交互（文档内嵌入画布）：
  // Drawnix 组件 options.readonly 写死 false、@plait/draw 不读只读位、也无运行时 setReadOnly API，
  // 故「只读」在本项目一直靠遮罩。但全屏遮罩会连 wheel 一起拦死，无法缩放。
  // 这里改在容器捕获阶段拦截「结构编辑手势」（pointerdown 起手拖拽/绘制、双击改文字、右键菜单、
  // 键盘编辑、pointermove 悬停延伸幽灵预览），但主动放行 wheel —— 鼠标滚轮与触控板捏合/平移
  // 都以 wheel 事件下发，可直达 Drawnix 的缩放/平移处理；工具栏另由 CSS 隐藏。
  // 全部五种事件统一按「目标是否在 overlay / 关联卡内」判定（见下方 blockUnlessOverlay）。
  useEffect(() => {
    if (!readonly || !allowViewInteraction) return;
    const el = wrapRef.current;
    if (!el) return;
    // 事件目标是否落在我方增强 overlay 内（节点角标 / 关联预览卡 / 样式条 / 其弹窗）。
    // 这些是只读页仍需可点的查看交互（展开关联、收起、跳转等），必须放行，
    // 否则公开分享页的关联角标会和画布编辑手势一起被吞掉（表现为"看得到、点不开"）。
    const inOverlay = (target: EventTarget | null) =>
      target instanceof Element &&
      // overlay 浮层（样式条/角标卡），以及统一层级后经 foreignObject 注入 svg 的关联卡
      // （data-gx-link-fo）——只读模式下卡片内的点击/双击/右键必须放行，否则跳转/角标展不开。
      (!!target.closest?.("[data-gx-overlay='1']") || !!target.closest?.("[data-gx-link-fo]"));
    // 仅拦截指向画布本体的编辑手势；overlay 内的同名事件直接放行。
    const blockUnlessOverlay = (e: Event) => {
      if (inOverlay(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    // P0-⑤：pointermove 此前无论目标在哪一律拦（原意是屏蔽悬停幽灵预览/连线悬停态），
    // 但它同样会吃掉落在 overlay / 关联卡 [data-gx-link-fo] 上的 move —— 内层嵌套预览
    // 的首帧测量正是靠这些 move 驱动的，全拦会让内层子画布永远测不出尺寸、停在空白。
    // 收窄为与 pointerdown 同一套目标判定：只拦指向画布本体的 move。
    el.addEventListener("pointerdown", blockUnlessOverlay, true);
    el.addEventListener("dblclick", blockUnlessOverlay, true);
    el.addEventListener("contextmenu", blockUnlessOverlay, true);
    el.addEventListener("pointermove", blockUnlessOverlay, true);
    el.addEventListener("keydown", blockUnlessOverlay, true);
    return () => {
      el.removeEventListener("pointerdown", blockUnlessOverlay, true);
      el.removeEventListener("dblclick", blockUnlessOverlay, true);
      el.removeEventListener("contextmenu", blockUnlessOverlay, true);
      el.removeEventListener("pointermove", blockUnlessOverlay, true);
      el.removeEventListener("keydown", blockUnlessOverlay, true);
    };
    // 必须含 Comp：wrap div 仅在动态 import 就绪（Comp 非 null）后才渲染，
    // 首次挂载时 wrapRef 为 null；依赖 Comp 才能在 wrap 挂载后重跑并真正绑定监听。
  }, [readonly, allowViewInteraction, Comp]);

  // 编辑中拦截 Drawnix 自带的"保存为文件/导出图片"下载行为（保存统一走云端，不产生本地文件）。
  // 注意：左上角 app 菜单（保存/打开/导出/清空）已通过 CSS 在编辑态隐藏，这里是双保险，
  // 拦截任何残留 <a download> / saveAs 触发的点击。
  useEffect(() => {
    if (readonly) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.("a[download]") as HTMLAnchorElement | null;
      if (a) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [readonly]);

  // 统一保存快捷键：Cmd/Ctrl+S 仅执行云端保存（onSave），不触发 Drawnix 自带的"保存为文件"下载。
  // 在容器捕获阶段拦截，先于 Drawnix 键盘插件（react-board 容器 onKeyDown，冒泡阶段）执行：
  // preventDefault 阻止浏览器保存对话框，stopPropagation 阻止库的 wn(board) 文件下载。
  useEffect(() => {
    if (readonly) return;
    const el = wrapRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        e.stopPropagation();
        void onSaveRef.current?.();
      }
    };
    el.addEventListener("keydown", onKeyDown, true);
    return () => el.removeEventListener("keydown", onKeyDown, true);
    // 同样必须含 Comp：wrap div 在动态 import 就绪后才挂载（见上一个 effect 说明）。
  }, [readonly, Comp]);

  const handleViewportChange = (vp: { zoom?: number; origination?: [number, number] }) => {
    onViewportRef.current?.(vp);
  };

  function handleChange(els: PlaitElement[]) {
    if (readonlyRef.current) return;
    const json = JSON.stringify(els);
    if (json === lastEmitted.current) return;
    lastEmitted.current = json;
    onContentChange?.(json);
  }

  function handleAfterInit(board: any) {
    boardRef.current = board;
    if (enhance) {
      setBoard(board);
      // overlay portal 挂到【外层 kb-canvas-wrap】而非 plait 自己的 .plait-board-container：
      // 样式条/色板/预览卡上的 pointerdown 在 DOM 事件路径上不再经过 plait 容器，
      // 画布的框选/清选区/延伸手势天然收不到，避免点工具条导致节点选区被清空。
      // fixed 定位相对视口，挂父层不影响坐标；坐标换算仍走 PlaitBoard.getHost。
      setContainer(wrapRef.current);
      // 关联块卡片经 foreignObject 注入到了 plait 的 svg 内（统一层级，见 LinkBlockForeignObject），
      // 因此卡片成为 plait 容器的事件后代。这里包装板级事件方法：当事件目标落在卡片
      // [data-gx-link-fo] 内时，跳过【外层板】的手势/双击/键盘处理，避免点卡片或在卡片内嵌
      // 子画布里操作时误触发外层板的框选/拖拽绘制/双击改文字/删除等。
      // 关键点：只短路板方法本身，不做 DOM stopPropagation —— React18 合成事件委托在根容器，
      // 原生阻断会连卡片按钮的 React 事件一起杀死。板方法跳过了，事件仍正常冒泡到 React 根。
      installLinkBoardGuards(board, wrapRef.current);
    } else if (readonly) {
      // P0-② 残影：只读预览（文档内嵌画布 / 版本快照 / 内嵌子画布）此前没有任何板守卫，
      // 落在关联卡里的 pointerdown 会起手 plait 的框选/拖拽/绘制，而预览是非受控的
      // （value 只在挂载时读一次、选区不回灌），这些瞬时状态就永久留在画面上。
      // 这里整体短路板手势，预览只保留 wheel 缩放平移与命令式 fit/zoom（都不经板方法）。
      installPreviewBoardGuards(board);
    }
    // Plait board 只读设置（不同版本 API 名略有差异，做容错）
    try {
      if (readonly) {
        if (typeof board?.setReadOnly === "function") board.setReadOnly(true);
        else if (board && typeof board.setIsReadonly === "function") board.setIsReadonly(true);
        else if (board?.options) board.options.readonly = true;
      }
    } catch {
      /* 忽略：只读设置失败不影响编辑 */
    }
    // C-1：只读数据层兜底。事件捕获拦截可能漏掉程序化调用/未来插件新手势/IME 合成事件，
    // 这里包装 board.apply：只拦数据变更类 op，保证只读预览的 board 数据与源 JSON 始终一致。
    // 注意（P0-⑤）：旧实现只放行 set_viewport、其余一律静默 return undefined，把
    // set_selection / set_interaction 这类「视图态」op 也吞了 —— plait 靠它们推进首次
    // 布局与绘制，被吞后板停在 origin(0,0)/zoom 1，预览区纯白。现在只拦改内容的 op。
    if (readonly) {
      try {
        const origApply = board.apply?.bind(board);
        if (origApply) {
          board.apply = (op: { type?: string }) => {
            if (!isDataMutatingOp(op?.type)) return origApply(op as never);
            if (import.meta.env.DEV) console.debug("[gx] readonly board blocked op:", op?.type);
            return undefined;
          };
        }
      } catch {
        /* 兜底失败不影响预览 */
      }
    }
    // 只读预览：初始化后自动适配全貌。容器尺寸为 0 时下一帧重试，fit 失败按包围盒手算兜底，
    // 全程不再静默（详见 canvas/readonly-preview.ts）。取消句柄存 ref，卸载时收掉。
    if (fitOnLoadRef.current) {
      cancelFitRef.current?.();
      cancelFitRef.current = fitViewportWhenReady(board, {
        onDone: (zoom) => onViewportRef.current?.({ zoom }),
      });
    }
  }

  if (!Comp) {
    return (
      <div className="flex h-full items-center justify-center text-gx-13 text-gx-text-hint">
        画布加载中…
      </div>
    );
  }

  const D = Comp as DrawnixType;

  const drawnix = (
    <D
      value={initialValue}
      onValueChange={handleChange}
      onViewportChange={handleViewportChange}
      afterInit={handleAfterInit}
      className="h-full w-full"
      onChange={
        enhance
          ? () => {
              // children/selection/viewport 任一变化都驱动增强 overlay 重定位（rAF 合帧）
              handlesRef.current?.notify();
            }
          : undefined
      }
    />
  );

  return (
    <div
      ref={wrapRef}
      className="kb-canvas-wrap"
      data-readonly={readonly ? "1" : "0"}
      data-enhance={enhance ? "1" : undefined}
      tabIndex={-1}
    >
      {enhance ? (
        <CanvasBoardProvider
          board={board}
          container={container}
          ctx={enhance}
          onHandles={(h) => {
            handlesRef.current = h;
          }}
        >
          {drawnix}
          {/* 节点增强 UI（注释角标/关联文档预览）与选中设置面板均 portal 到画布容器 */}
          <CanvasEnhanceOverlay />
        </CanvasBoardProvider>
      ) : (
        drawnix
      )}
      {/* 只读预览（历史版本）：遮罩拦截所有指针 + CSS 隐藏自带工具栏，保证快照不可编辑 */}
      {readonly && !allowViewInteraction && <div className="kb-canvas-readonly-mask" aria-hidden="true" />}
    </div>
  );
});
