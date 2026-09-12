// apps/web/src/features/kb/canvas/DocRefPickerPopover.tsx
// 节点设置面板里的「关联文档/画布」选择弹层（#119）。
// 内部复用 CanvasLinkPicker (mode="attach") —— 列表/搜索/tab/新建/取消关联全部委托，
// 仅保留自有容器（PopoverShell + 标题 + 宽度）+ attach 模式必需的回调桥接。
//
// 写入语义：setElementDocRef(element, {docId, kind, title}) → onClose() → rt.refreshSelection()。

import type { PlaitElement } from "@plait/core";
import { Icon } from "../../../components/icons";
import { useCanvasBoard } from "./canvas-context";
import { PopoverShell } from "./style-popups";
import { AttachRefPicker } from "./CanvasLinkPicker";

export function DocRefPickerPopover({
  x,
  y,
  element,
  onClose,
}: {
  x: number;
  y: number;
  element: PlaitElement;
  onClose: () => void;
}) {
  const rt = useCanvasBoard();
  // 节点 element 即对应 GxShapeElement（NodeStyleBar 调用点保证 singleShape 是 geometry）
  const asShape = element as Parameters<typeof AttachRefPicker>[0]["element"];

  return (
    <PopoverShell x={x} y={y} width={300} onClose={onClose}>
      <div className="mb-1.5 flex items-center gap-1.5 text-gx-12 font-medium text-gx-text-secondary">
        <Icon name="link" size={14} />
        关联文档或画布
      </div>
      {rt?.ctx.publicToken ? (
        <div className="px-1 py-3 text-center text-gx-12 text-gx-text-hint">
          分享页暂不支持新建关联，仅可查看已有关联。
        </div>
      ) : (
        <AttachRefPicker anchor={{ x, y }} element={asShape} onClose={onClose} />
      )}
    </PopoverShell>
  );
}
