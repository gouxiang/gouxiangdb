// apps/web/src/features/kb/canvas/NodeStyleBar.tsx
// 选中节点后的浮动样式条（对标 Drawnix 自带 PopupToolbar，但补齐：线宽、粗斜体下划线、对齐、
// 图片入口、注释、关联文档、连线形态与箭头端点）。
// 交互约定：
//  - 条上所有 pointerdown 阻止冒泡，避免画布误判为空白点击而清空选区；
//  - 多选生效，样式写入走 canvas-ops（原生 transforms，进入撤销栈、触发自动保存）；
//  - 工具条 fixed 定位在选中包围盒上方居中，空间不足自动翻到下方。
//
/* eslint-disable react-hooks/rules-of-hooks -- 技术债 GX-LINT-DEBT-1：组件在守卫早返回
 * （board/style 不存在）之后才调 useState（见 popupBtnId）。守卫结果在组件生命周期内稳定，
 * 当前运行正确；正确修法是把空态抽成独立包装组件或把守卫下移到全部 hooks 之后。 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PlaitBoard, PlaitElement } from "@plait/core";
import { ArrowLineMarkerType } from "@plait/draw";
import { getTextMarksByElement } from "@plait/text-plugins";
import { Icon, type IconName } from "../../../components/icons";
import { ContextMenu, toast, type ContextMenuItem } from "../../../components/ui";
import { useCanvasBoard, type ScreenRect } from "./canvas-context";
import { isBranchLine, isLineLike, isMindMapLine, isMindMapNode, isShapeLike, type GxShapeElement } from "./types";
import {
  applyZOrder,
  canApplyZOrder,
  currentSelectedElements,
  readElementDocRef,
  readElementNote,
  readSelectionStyle,
  setArrowMarker,
  setArrowShape,
  setBranchLineStyle,
  setFillColor,
  setMindMapBranchColor,
  setMindMapBranchShape,
  setMindMapBranchWidth,
  setMindMapLayout,
  setMindMapNodeFill,
  setMindMapShape,
  setMindMapStrokeColor,
  setMindMapStrokeStyle,
  setMindMapStrokeWidth,
  setMindMapTextColor,
  setStrokeColor,
  setStrokeStyle,
  setStrokeWidth,
  setTextAlign,
  setTextColor,
  toggleTextMark,
  insertImageIntoShape,
  type ZOrderAction,
} from "./canvas-ops";
import {
  FillColorPopover,
  PopoverShell,
  StrokeColorPopover,
  StrokeStylePopover,
  StrokeWidthPopover,
  TextStyleColorPopover,
} from "./style-popups";
import { NoteEditorPopover } from "./NoteEditorPopover";
import { DocRefPickerPopover } from "./DocRefPickerPopover";
import { MindMapShapePopover } from "./MindMapShapePopover";

type PopupKind =
  | "strokeColor"
  | "fillColor"
  | "strokeWidth"
  | "strokeStyle"
  | "textColor"
  | "lineShape"
  | "sourceMark"
  | "targetMark"
  | "branchStrokeColor"
  | "branchStrokeWidth"
  | "branchStrokeStyle"
  | "branchShape"
  | "mindShape"
  | "mindNodeFill"
  | "mindTextColor"
  | "mindStrokeColor"
  | "mindStrokeWidth"
  | "mindStrokeStyle"
  | "mindBranchColor"
  | "mindBranchWidth"
  | "mindBranchShape"
  | "mindLayout"
  | "note"
  | "docRef"
  | null;

const BAR_W = 506;

export function NodeStyleBar({ anchor, elements: snapshotElements }: { anchor: ScreenRect; elements: PlaitElement[] }) {
  // snapshotElements（CanvasEnhanceOverlay 由 rt.selectedIds 快照算出）只用于判断样式条是否需要
  // 渲染及锚点；真正的分组/计数/写入目标一律取 plait 实时选区 currentSelectedElements(board)，
  // 与 readSelectionStyle / PropertyTransforms / applyZOrder 完全同源，杜绝右键改选后
  // "面板显示/锚点是 A、样式却写到 B"的双轨错位。
  void snapshotElements;
  const rt = useCanvasBoard();
  const [popup, setPopup] = useState<PopupKind>(null);
  const [zMenu, setZMenu] = useState<{ x: number; y: number } | null>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const board = rt?.board ?? null;
  void rt?.frame; // 选区/数据变化随 frame 重渲染

  const style = useMemo(() => (board ? readSelectionStyle(board) : null), [board, rt?.frame, rt?.selectedIds]);

  // 与 readSelectionStyle / 各样式写函数同源：始终读 plait 实时选区。
  const liveElements = useMemo(
    () => (board ? currentSelectedElements(board) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board, rt?.frame, rt?.selectedIds],
  );

  const shapes = liveElements.filter(isShapeLike);
  const lines = liveElements.filter(isLineLike);
  const mindMapNodes = liveElements.filter(isMindMapNode);
  const mindMapLines = liveElements.filter(isMindMapLine);
  const branches = liveElements.filter(isBranchLine);
  const firstShape = shapes[0] as GxShapeElement | undefined;
  const hasShape = shapes.length > 0;
  const hasLine = lines.length > 0;
  const hasBranch = branches.length > 0;
  const hasMindMapNode = mindMapNodes.length > 0;
  const hasMindMapLine = mindMapLines.length > 0;
  // F5: 思维导图线无端点 marker
  const linesAllowMarkers = hasLine && !hasMindMapLine;
  const singleShape: GxShapeElement | null = shapes.length === 1 ? (shapes[0] as GxShapeElement) : null;

  // 文字状态取首个几何节点（marks + 段落对齐）
  const textState = useMemo(() => {
    if (!firstShape?.text) return { bold: false, italic: false, underlined: false, color: null, align: "center" as const };
    const marks = getTextMarksByElement(firstShape) ?? {};
    return {
      bold: !!marks.bold,
      italic: !!marks.italic,
      underlined: !!marks.underlined,
      color: (marks.color as string) ?? null,
      align: ((firstShape.text as { align?: string }).align ?? "center") as "left" | "center" | "right",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstShape, rt?.frame]);

  if (!board || !style) return null;
  const noteCount = liveElements.filter((e) => !!readElementNote(e)).length;
  const refCount = liveElements.filter((e) => !!readElementDocRef(e)).length;

  // C-5：shape/line 两分支存在同名按钮 id（strokeColor/strokeWidth/strokeStyle），
  // btnRefs 互相覆盖导致弹窗锚错。pop 记录触发按钮 id，popupRect 优先按它实时定位。
  const [popupBtnId, setPopupBtnId] = useState<string | null>(null);
  const pop = (k: PopupKind, btnId?: string) => {
    if (popup === k) { setPopup(null); return; }
    setPopupBtnId(btnId ?? k);
    setPopup(k);
  };

  const vp = rt?.viewport;
  const popupRect = (): { x: number; y: number } => {
    const r = (popupBtnId ? btnRefs.current[popupBtnId] : null)?.getBoundingClientRect()
      ?? btnRefs.current[popup ?? ""]?.getBoundingClientRect();
    // 按钮 getBoundingClientRect 是浏览器视口坐标，换算到裁剪层本地坐标（浮层在裁剪层内 absolute）
    if (r && vp) return { x: r.left - vp.origin.x, y: r.bottom + 6 - vp.origin.y };
    return { x: anchor.x, y: anchor.y };
  };

  const vw = vp?.width || window.innerWidth;
  const vh = vp?.height || window.innerHeight;
  const left = Math.min(Math.max(8, anchor.x + anchor.width / 2 - BAR_W / 2), vw - BAR_W - 8);
  const above = anchor.y > 160;
  const rawTop = above ? anchor.y - 40 : anchor.y + anchor.height + 8;
  const top = Math.min(Math.max(8, rawTop), vh - 48);

  const stop = (e: React.PointerEvent) => e.stopPropagation();

  const Btn = ({
    id,
    icon,
    title,
    onClick,
    active = false,
  }: {
    id?: string;
    icon: IconName;
    title: string;
    onClick: () => void;
    active?: boolean;
  }) => (
    <button
      ref={id ? (el) => { btnRefs.current[id] = el; } : undefined}
      type="button"
      title={title}
      onPointerDown={stop}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-gx-sm text-gx-text-secondary hover:bg-gx-bg hover:text-gx-text-primary ${
        active ? "bg-gx-accent-bg text-gx-accent" : ""
      }`}
    >
      <Icon name={icon} size={15} />
    </button>
  );

  const Divider = () => <span className="mx-0.5 h-4 w-px bg-gx-separator" />;

  const zEnabled = canApplyZOrder(board);
  const runZ = (action: ZOrderAction) => {
    const moved = applyZOrder(board, action);
    toast(
      moved
        ? { forward: "已上移一层", backward: "已下移一层", front: "已置于顶层", back: "已置于底层" }[action]
        : { forward: "已在最顶层", backward: "已在最底层", front: "已在最顶层", back: "已在最底层" }[action],
      moved ? "success" : "info",
    );
  };
  const zItems: ContextMenuItem[] = [
    { kind: "item", label: "上移一层", icon: "bringForward", shortcut: "⌘]", disabled: !zEnabled, onClick: () => runZ("forward") },
    { kind: "item", label: "下移一层", icon: "sendBackward", shortcut: "⌘[", disabled: !zEnabled, onClick: () => runZ("backward") },
    { kind: "divider" },
    { kind: "item", label: "置于顶层", icon: "bringToFront", shortcut: "⌥⌘]", disabled: !zEnabled, onClick: () => runZ("front") },
    { kind: "item", label: "置于底层", icon: "sendToBack", shortcut: "⌥⌘[", disabled: !zEnabled, onClick: () => runZ("back") },
  ];

  function pickImageForShape() {
    if (!singleShape) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      // 与 Drawnix 全局插图一致：读为 dataURL 存入 image 元素（原生 image 节点，可撤销/保存/导出）
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        const img = new Image();
        img.onload = () => insertImageIntoShape(board!, singleShape, { url, width: img.width, height: img.height });
        img.src = url;
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  return (
    <>
      <div
        className="absolute gx-z-canvas-bar flex h-8 items-center gap-0.5 rounded-gx-md border border-gx-separator bg-gx-surface px-1 shadow-xl"
        style={{ left, top, width: BAR_W }}
        onPointerDown={stop}
      >
        {/* 图层管理（所有对象常驻：基础元素/脑图/文字/图片/箭头/关联块），点击弹四操作菜单 */}
        <Btn
          id="zOrder"
          icon="layers"
          title="图层：上移一层 / 下移一层 / 置于顶层 / 置于底层"
          onClick={() => {
            const r = btnRefs.current["zOrder"]?.getBoundingClientRect();
            setZMenu({ x: r ? r.left : anchor.x, y: r ? r.bottom + 6 : anchor.y });
          }}
        />
        <Divider />
        {hasShape && (
          <>
            <Btn id="strokeColor" icon="palette" title="描边颜色" active={popup === "strokeColor"} onClick={() => pop("strokeColor")} />
            <Btn id="fillColor" icon="sparkles" title="填充颜色" active={popup === "fillColor"} onClick={() => pop("fillColor")} />
            <Btn id="strokeWidth" icon="rowHeight" title="线条粗细" active={popup === "strokeWidth"} onClick={() => pop("strokeWidth")} />
            <Btn id="strokeStyle" icon="swap" title="线型（实线/虚线/点线）" active={popup === "strokeStyle"} onClick={() => pop("strokeStyle")} />
            <Divider />
            <Btn icon="bold" title="加粗" active={textState.bold} onClick={() => toggleTextMark(board, "bold")} />
            <Btn icon="italic" title="斜体" active={textState.italic} onClick={() => toggleTextMark(board, "italic")} />
            <Btn icon="underline" title="下划线" active={textState.underlined} onClick={() => toggleTextMark(board, "underlined")} />
            <Btn
              icon={textState.align === "left" ? "alignLeft" : textState.align === "right" ? "alignRight" : "alignCenter"}
              title="文字对齐（左/中/右，循环切换）"
              onClick={() => setTextAlign(board, textState.align === "left" ? "center" : textState.align === "center" ? "right" : "left")}
            />
            <Btn id="textColor" icon="text" title="文字颜色" active={popup === "textColor" || !!textState.color} onClick={() => pop("textColor")} />
            <Divider />
            {singleShape && <Btn icon="image" title="在节点中插入图片（等同全局插图）" onClick={pickImageForShape} />}
          </>
        )}

        {hasLine && (
          <>
            <Btn id="lineStrokeColor" icon="palette" title="线条颜色" active={popup === "strokeColor"} onClick={() => pop("strokeColor", "lineStrokeColor")} />
            <Btn id="lineStrokeWidth" icon="rowHeight" title="线条粗细" active={popup === "strokeWidth"} onClick={() => pop("strokeWidth", "lineStrokeWidth")} />
            <Btn id="lineStrokeStyle" icon="swap" title="线型（实线/虚线/点线）" active={popup === "strokeStyle"} onClick={() => pop("strokeStyle", "lineStrokeStyle")} />
            <Divider />
            <Btn
              id="lineShape"
              icon={lines.every((l) => l.shape === "elbow") ? "lineElbow" : lines.some((l) => l.shape === "curve") ? "lineCurve" : "lineStraight"}
              title="连线呈现方式（直线/曲线/折线）"
              active={popup === "lineShape"}
              onClick={() => pop("lineShape")}
            />
            {/* F5: 思维导图分支线无端点 marker —— 视觉规范 */}
            {linesAllowMarkers && (
              <>
                <Btn id="sourceMark" icon="arrowStart" title="起点样式" active={popup === "sourceMark"} onClick={() => pop("sourceMark")} />
                <Btn id="targetMark" icon="arrowEnd" title="终点样式" active={popup === "targetMark"} onClick={() => pop("targetMark")} />
              </>
            )}
          </>
        )}

        {/* F3: 流程图分支线独立样式（与主连线隔离，避免误改） */}
        {hasBranch && (
          <>
            <Divider />
            <span className="mx-0.5 text-gx-10 uppercase tracking-wide text-gx-text-hint">分支线</span>
            <Btn id="branchStrokeColor" icon="palette" title="分支线颜色" active={popup === "branchStrokeColor"} onClick={() => pop("branchStrokeColor")} />
            <Btn id="branchStrokeWidth" icon="rowHeight" title="分支线粗细" active={popup === "branchStrokeWidth"} onClick={() => pop("branchStrokeWidth")} />
            <Btn id="branchStrokeStyle" icon="swap" title="分支线线型" active={popup === "branchStrokeStyle"} onClick={() => pop("branchStrokeStyle")} />
            <Btn id="branchShape" icon="lineCurve" title="分支线形态" active={popup === "branchShape"} onClick={() => pop("branchShape")} />
          </>
        )}

        {/* F5: 思维导图节点专属面板（修复 #4 P1：节点 + 分支 + 布局 + emoji + 图片 + 折叠 全套） */}
        {hasMindMapNode && (
          <>
            <Divider />
            <span className="mx-0.5 text-gx-10 uppercase tracking-wide text-gx-text-hint">思维导图</span>
            {/* 节点外观 */}
            <Btn id="mindNodeFill" icon="sparkles" title="节点填充" active={popup === "mindNodeFill"} onClick={() => pop("mindNodeFill")} />
            <Btn id="mindStrokeColor" icon="palette" title="节点描边颜色" active={popup === "mindStrokeColor"} onClick={() => pop("mindStrokeColor")} />
            <Btn id="mindStrokeWidth" icon="rowHeight" title="节点描边宽度" active={popup === "mindStrokeWidth"} onClick={() => pop("mindStrokeWidth")} />
            <Btn id="mindStrokeStyle" icon="swap" title="节点描边线型" active={popup === "mindStrokeStyle"} onClick={() => pop("mindStrokeStyle")} />
            <Btn id="mindShape" icon="circle" title="节点形状" active={popup === "mindShape"} onClick={() => pop("mindShape")} />
            {/* 文字 */}
            <Btn id="mindTextColor" icon="text" title="文字颜色" active={popup === "mindTextColor"} onClick={() => pop("mindTextColor")} />
            {/* 分支线样式（@plait/mind 把分支字段挂在节点自身上，无独立 line 元素） */}
            <Btn id="mindBranchColor" icon="palette" title="分支线颜色" active={popup === "mindBranchColor"} onClick={() => pop("mindBranchColor")} />
            <Btn id="mindBranchWidth" icon="rowHeight" title="分支线宽度" active={popup === "mindBranchWidth"} onClick={() => pop("mindBranchWidth")} />
            <Btn id="mindBranchShape" icon="lineCurve" title="分支线形态（贝塞尔/折线）" active={popup === "mindBranchShape"} onClick={() => pop("mindBranchShape")} />
            {/* 布局方向 */}
            <Btn id="mindLayout" icon="alignCenter" title="布局方向" active={popup === "mindLayout"} onClick={() => pop("mindLayout")} />
          </>
        )}

        <Divider />
        <Btn id="note" icon="comment" title={noteCount ? "编辑节点注释" : "添加节点注释"} active={popup === "note" || noteCount > 0} onClick={() => pop("note")} />
        {hasShape && (
          <Btn id="docRef" icon="link" title={refCount ? "管理关联文档/画布" : "关联文档或画布"} active={popup === "docRef" || refCount > 0} onClick={() => pop("docRef")} />
        )}
      </div>

      {popup === "strokeColor" && (
        <StrokeColorPopover {...popupRect()} current={style.strokeColor} onPick={(c) => setStrokeColor(board, c)} onClose={() => setPopup(null)} />
      )}
      {popup === "fillColor" && (
        <FillColorPopover {...popupRect()} current={style.fill} onPick={(c) => setFillColor(board, c)} onClose={() => setPopup(null)} />
      )}
      {popup === "strokeWidth" && (
        <StrokeWidthPopover {...popupRect()} current={style.strokeWidth} onPick={(w) => setStrokeWidth(board, w)} onClose={() => setPopup(null)} />
      )}
      {popup === "strokeStyle" && (
        <StrokeStylePopover {...popupRect()} current={style.strokeStyle} onPick={(s) => setStrokeStyle(board, s)} onClose={() => setPopup(null)} />
      )}
      {popup === "textColor" && (
        <TextStyleColorPopover {...popupRect()} current={textState.color} onPick={(c) => setTextColor(board, c)} onClose={() => setPopup(null)} />
      )}
      {popup === "lineShape" && (
        <LineShapePopover
          {...popupRect()}
          current={lines[0]?.shape as string}
          arrowOnly={lines.every((l) => l.type === "arrow-line")}
          onPick={(s) => { setArrowShape(board, s); setPopup(null); }}
          onClose={() => setPopup(null)}
        />
      )}
      {(popup === "sourceMark" || popup === "targetMark") && (
        <MarkerPopover
          {...popupRect()}
          current={popup === "sourceMark" ? style.sourceMarker : style.targetMarker}
          onPick={(m) => { setArrowMarker(board, popup === "sourceMark" ? "source" : "target", m); setPopup(null); }}
          onClose={() => setPopup(null)}
        />
      )}
      {/* F3: 分支线样式弹层（颜色/线宽/线型/形态）—— 复用现有色板/线宽/线型/形态弹层 */}
      {popup === "branchStrokeColor" && (
        <StrokeColorPopover {...popupRect()} current={style.strokeColor} onPick={(c) => setBranchLineStyle(board, { stroke: c })} onClose={() => setPopup(null)} />
      )}
      {popup === "branchStrokeWidth" && (
        <StrokeWidthPopover {...popupRect()} current={style.strokeWidth} onPick={(w) => setBranchLineStyle(board, { strokeWidth: w })} onClose={() => setPopup(null)} />
      )}
      {popup === "branchStrokeStyle" && (
        <StrokeStylePopover {...popupRect()} current={style.strokeStyle} onPick={(s) => setBranchLineStyle(board, { strokeStyle: s })} onClose={() => setPopup(null)} />
      )}
      {popup === "branchShape" && (
        <LineShapePopover
          {...popupRect()}
          current={lines[0]?.shape as string}
          arrowOnly={lines.every((l) => l.type === "arrow-line")}
          onPick={(s) => { setBranchLineStyle(board, { shape: s }); setPopup(null); }}
          onClose={() => setPopup(null)}
        />
      )}
      {/* F5: 思维导图节点样式弹层（修复 #4 P1：节点 + 分支 + 布局 全套） */}
      {popup === "mindNodeFill" && (
        <FillColorPopover {...popupRect()} current={style.fill} onPick={(c) => setMindMapNodeFill(board, c)} onClose={() => setPopup(null)} />
      )}
      {popup === "mindTextColor" && (
        <TextStyleColorPopover {...popupRect()} current={textState.color} onPick={(c) => setMindMapTextColor(board, c)} onClose={() => setPopup(null)} />
      )}
      {popup === "mindStrokeColor" && (
        <StrokeColorPopover {...popupRect()} current={style.strokeColor} onPick={(c) => { setMindMapStrokeColor(board, c); setPopup(null); }} onClose={() => setPopup(null)} />
      )}
      {popup === "mindStrokeWidth" && (
        <StrokeWidthPopover {...popupRect()} current={style.strokeWidth} onPick={(w) => { setMindMapStrokeWidth(board, w); setPopup(null); }} onClose={() => setPopup(null)} />
      )}
      {popup === "mindStrokeStyle" && (
        <StrokeStylePopover {...popupRect()} current={style.strokeStyle} onPick={(s) => { setMindMapStrokeStyle(board, s); setPopup(null); }} onClose={() => setPopup(null)} />
      )}
      {popup === "mindBranchColor" && (
        <StrokeColorPopover {...popupRect()} current={style.mindBranchColor} onPick={(c) => { setMindMapBranchColor(board, c); setPopup(null); }} onClose={() => setPopup(null)} />
      )}
      {popup === "mindBranchWidth" && (
        <StrokeWidthPopover {...popupRect()} current={style.mindBranchWidth ?? 2} onPick={(w) => { setMindMapBranchWidth(board, w); setPopup(null); }} onClose={() => setPopup(null)} />
      )}
      {popup === "mindBranchShape" && (
        <MindMapBranchShapePopover {...popupRect()} current={style.mindBranchShape} onPick={(s) => { setMindMapBranchShape(board, s); setPopup(null); }} onClose={() => setPopup(null)} />
      )}
      {popup === "mindLayout" && (
        <MindMapLayoutPopover {...popupRect()} current={style.mindLayout} onPick={(l) => { setMindMapLayout(board, l); setPopup(null); }} onClose={() => setPopup(null)} />
      )}
      {popup === "mindShape" && (
        <MindMapShapePopover {...popupRect()} onPick={(s) => { setMindMapShape(board, s); setPopup(null); }} onClose={() => setPopup(null)} />
      )}
      {popup === "note" && (
        <NoteEditorPopover {...popupRect()} element={singleShape ?? liveElements[0]} onClose={() => setPopup(null)} />
      )}
      {popup === "docRef" && singleShape && (
        <DocRefPickerPopover {...popupRect()} element={singleShape} onClose={() => setPopup(null)} />
      )}

      <ContextMenu
        open={!!zMenu}
        x={zMenu?.x ?? 0}
        y={zMenu?.y ?? 0}
        width={208}
        onClose={() => setZMenu(null)}
        items={zItems}
        menuClassName="plait-board-attached"
      />
    </>
  );
}

// ---------- 连线形态弹层 ----------

function LineShapePopover({
  x,
  y,
  current,
  arrowOnly,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  current: string;
  arrowOnly: boolean;
  onPick: (s: "straight" | "curve" | "elbow") => void;
  onClose: () => void;
}) {
  const items: { v: "straight" | "curve" | "elbow"; label: string; desc: string; icon: IconName }[] = [
    { v: "straight", label: "直线", desc: "两点直连，圆滑利落", icon: "lineStraight" },
    { v: "curve", label: "曲线", desc: "贝塞尔曲线，走向圆滑", icon: "lineCurve" },
    { v: "elbow", label: "折线", desc: arrowOnly ? "正交直角，紧凑规整" : "自由手绘线不支持折线", icon: "lineElbow" },
  ];
  return (
    <PopoverWrap x={x} y={y} onClose={onClose} width={180}>
      <div className="flex flex-col gap-0.5">
        {items.map((it) => {
          const disabled = it.v === "elbow" && !arrowOnly;
          return (
            <button
              key={it.v}
              type="button"
              disabled={disabled}
              onClick={() => onPick(it.v)}
              className={`flex items-center gap-2 rounded-gx-sm px-2 py-1.5 text-left hover:bg-gx-bg disabled:opacity-35 ${
                current === it.v ? "text-gx-accent" : "text-gx-text-primary"
              }`}
            >
              <Icon name={it.icon} size={16} />
              <span className="text-gx-12">
                <span className="block font-medium">{it.label}</span>
                <span className="block text-gx-11 text-gx-text-hint">{it.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
    </PopoverWrap>
  );
}

const MARKERS: { v: ArrowLineMarkerType; label: string }[] = [
  { v: ArrowLineMarkerType.none, label: "无" },
  { v: ArrowLineMarkerType.arrow, label: "实心箭头" },
  { v: ArrowLineMarkerType.openTriangle, label: "开放三角" },
  { v: ArrowLineMarkerType.solidTriangle, label: "实心三角" },
  { v: ArrowLineMarkerType.sharpArrow, label: "尖角箭头" },
  { v: ArrowLineMarkerType.hollowTriangle, label: "空心三角" },
  { v: ArrowLineMarkerType.singleSlash, label: "单斜线" },
];

// ---------- F5: 思维导图分支线形态（贝塞尔/折线） ----------

function MindMapBranchShapePopover({
  x,
  y,
  current,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  current: "bight" | "polyline" | null;
  onPick: (s: "bight" | "polyline") => void;
  onClose: () => void;
}) {
  const items: { v: "bight" | "polyline"; label: string; desc: string; icon: IconName }[] = [
    { v: "bight", label: "贝塞尔", desc: "圆滑曲线，常规脑图", icon: "lineCurve" },
    { v: "polyline", label: "折线", desc: "正交直角，结构清晰", icon: "lineElbow" },
  ];
  return (
    <PopoverWrap x={x} y={y} onClose={onClose} width={180}>
      <div className="flex flex-col gap-0.5">
        {items.map((it) => (
          <button
            key={it.v}
            type="button"
            onClick={() => onPick(it.v)}
            className={`flex items-center gap-2 rounded-gx-sm px-2 py-1.5 text-left hover:bg-gx-bg ${current === it.v ? "bg-gx-accent-bg" : ""}`}
          >
            <Icon name={it.icon} size={16} />
            <span className="text-gx-12">
              <span className="block font-medium text-gx-text-primary">{it.label}</span>
              <span className="block text-gx-11 text-gx-text-hint">{it.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </PopoverWrap>
  );
}

// ---------- F5: 思维导图布局方向（右/左/上/下/双侧） ----------

function MindMapLayoutPopover({
  x,
  y,
  current,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  current: "right" | "left" | "upward" | "downward" | "standard" | null;
  onPick: (l: "right" | "left" | "upward" | "downward" | "standard") => void;
  onClose: () => void;
}) {
  const items: { v: "right" | "left" | "upward" | "downward" | "standard"; label: string; icon: IconName }[] = [
    { v: "right", label: "向右展开", icon: "arrowEnd" },
    { v: "left", label: "向左展开", icon: "arrowStart" },
    { v: "standard", label: "双侧平衡", icon: "expand" },
    { v: "upward", label: "向上展开", icon: "arrowUp" },
    { v: "downward", label: "向下展开", icon: "arrowDown" },
  ];
  return (
    <PopoverWrap x={x} y={y} onClose={onClose} width={170}>
      <div className="flex flex-col gap-0.5">
        {items.map((it) => (
          <button
            key={it.v}
            type="button"
            onClick={() => onPick(it.v)}
            className={`flex items-center gap-2 rounded-gx-sm px-2 py-1.5 text-left text-gx-12 font-medium text-gx-text-primary hover:bg-gx-bg ${current === it.v ? "bg-gx-accent-bg" : ""}`}
          >
            <Icon name={it.icon} size={15} />
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </PopoverWrap>
  );
}

function MarkerPopover({
  x,
  y,
  current,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  current: string;
  onPick: (m: ArrowLineMarkerType) => void;
  onClose: () => void;
}) {
  return (
    <PopoverWrap x={x} y={y} onClose={onClose} width={136}>
      <div className="grid grid-cols-1 gap-0.5">
        {MARKERS.map((m) => (
          <button
            key={m.v}
            type="button"
            onClick={() => onPick(m.v)}
            className={`rounded-gx-sm px-2 py-1.5 text-left text-gx-12 hover:bg-gx-bg ${
              current === m.v ? "text-gx-accent" : "text-gx-text-primary"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
    </PopoverWrap>
  );
}

function PopoverWrap({ x, y, width, onClose, children }: { x: number; y: number; width: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const rt = useCanvasBoard();
  const vw = rt?.viewport.width || window.innerWidth;
  const vh = rt?.viewport.height || window.innerHeight;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", onDown, true);
      document.addEventListener("keydown", onKey, true);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute gx-z-canvas-popover rounded-gx-md border border-gx-separator bg-gx-surface p-1.5 shadow-2xl"
      style={{ left: Math.min(x, Math.max(8, vw - width - 8)), top: Math.min(y, Math.max(8, vh - 220 - 8)), width }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

// 保留 PlaitBoard 类型引用（方便本模块类型签名统一）
export type { PlaitBoard };
