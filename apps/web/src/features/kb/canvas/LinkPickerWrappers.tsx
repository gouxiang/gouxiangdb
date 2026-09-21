// apps/web/src/features/kb/canvas/LinkPickerWrappers.tsx
// CanvasLinkPicker 的两个便捷封装：
//   - InsertLinkBlockPicker：独立块场景（只关心 onInsert）
//   - AttachRefPicker：给现有元素挂 gxDocRef/gxLinkRef
// 从 CanvasLinkPicker.tsx 拆出以守住单文件 ≤300 行门禁；逻辑与拆分前一致。

import { useCanvasBoard } from "./canvas-context";
import { setElementDocRef, readElementDocRef } from "./canvas-ops";
import { CanvasLinkPicker } from "./CanvasLinkPicker";
import type { GxShapeElement, GxDocRef } from "./types";
import type { PickResult, PreviewType } from "./link-picker-types";

/** 把 PickResult 归一为落库用的 GxDocRef（table 场景带视图与 base 快照）。 */
export function toDocRef(ref: PickResult): GxDocRef {
  return {
    docId: ref.docId,
    kind: ref.kind,
    title: ref.title,
    ...(ref.viewId !== undefined ? { viewId: ref.viewId } : {}),
    ...(ref.viewName ? { viewName: ref.viewName } : {}),
    ...(ref.baseId ? { baseId: ref.baseId } : {}),
  };
}

export interface InsertLinkBlockPickerProps {
  /** 触发位置（caller 用来 popover 对齐） */
  anchor: { x: number; y: number };
  currentDocId?: string;
  /** 已选则调 insertLinkBlock（previewType 由 picker 内部 state 决定） */
  onInsert: (ref: PickResult, previewType: PreviewType) => void;
  onClose: () => void;
}

export function InsertLinkBlockPicker(props: InsertLinkBlockPickerProps) {
  return (
    <CanvasLinkPicker
      mode="standalone"
      anchor={props.anchor}
      currentDocId={props.currentDocId}
      onClose={props.onClose}
      showPreviewType
      onPickStandalone={(ref, previewType) => props.onInsert(ref, previewType ?? "full")}
    />
  );
}

export interface AttachRefPickerProps {
  anchor: { x: number; y: number };
  element: GxShapeElement;
  onClose: () => void;
}

export function AttachRefPicker(props: AttachRefPickerProps) {
  const rt = useCanvasBoard();
  const currentDocId = rt?.ctx.currentDocId;
  const existing = readElementDocRef(props.element);
  return (
    <CanvasLinkPicker
      mode="attach"
      anchor={props.anchor}
      currentDocId={currentDocId}
      attachElement={props.element}
      attachHasRef={!!existing}
      onClose={props.onClose}
      onPickAttach={(ref) => {
        if (!rt?.board) return;
        // 切换到新目标时：身份字段（docId/kind/title + table 的 viewId/viewName/baseId）
        // 一律用新选择；只沿用与目标无关的布局偏好 previewType（完整/极简）。
        // displayTitle 是针对旧目标的本地改名，切目标必须丢弃，否则新关联顶着旧标题。
        const next: GxDocRef = {
          ...toDocRef(ref),
          ...(existing?.previewType ? { previewType: existing.previewType } : {}),
        };
        setElementDocRef(rt.board, props.element, next);
        // setNode 改自定义字段后显式 notify 一次，确保角标/样式条关联态即时刷新。
        rt.notify();
        rt.refreshSelection();
      }}
      onAttachClear={() => {
        if (!rt?.board) return;
        setElementDocRef(rt.board, props.element, null);
        rt.notify();
        rt.refreshSelection();
      }}
    />
  );
}
