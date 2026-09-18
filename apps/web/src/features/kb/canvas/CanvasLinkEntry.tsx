// apps/web/src/features/kb/canvas/CanvasLinkEntry.tsx
// 画布编辑态左上角"关联"入口（KB-EDITOR-ROUND-4 §1.2.1 / §1.3）。
// 取代 LinkBlockInserter 的左下浮动按钮，挂到原 .app-toolbar 槽位（kb.css:309 隐藏后留出）。
// 点击 → 弹 CanvasLinkPicker（standalone 模式）→ 选 / 创建 → insertLinkBlock + EditorModal。

import { useRef, useState } from "react";
import { Icon } from "../../../components/icons";
import { Popover } from "../../../components/ui";
import { useCanvasBoard } from "./canvas-context";
import { insertLinkBlock } from "./canvas-ops";
import { EditorModal } from "./EditorModal";
import { InsertLinkBlockPicker } from "./CanvasLinkPicker";
import type { KbDocKind } from "../../../api/client";

/**
 * 左上角"关联"入口。仅编辑态可见；通过 CanvasOverlayLayer portal 渲染（继承 .kb-canvas-wrap 的 position:relative）。
 * 绝对定位在 top:36px left:36px —— 与 Drawnix 原 .app-toolbar 槽位对齐（被 kb.css:309 隐藏）。
 */
export function CanvasLinkEntry() {
  const rt = useCanvasBoard();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<
    | null
    | {
        docId: string;
        kind: KbDocKind;
        title: string;
      }
  >(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  if (!rt?.board || !rt.ctx.canEdit) return null;
  const kbId = rt.ctx.kbId;
  const currentDocId = rt.ctx.currentDocId;
  // 公开分享页暂不允许关联入口（沿用 LinkBlockInserter 旧策略：内部页才显示新建按钮）
  if (rt.ctx.publicToken) return null;

  function handlePick(docId: string, kind: KbDocKind, title: string, previewType: "full" | "minimal") {
    if (!rt?.board) return;
    insertLinkBlock(
      rt.board,
      { docId, kind, title: title || "未命名", previewType },
      { cascade: true },
    );
    setOpen(false);
    // 立即打开 EditorModal 让用户填标题/正文
    setCreating({ docId, kind, title: title || "未命名" });
  }

  return (
    <>
      <div
        className="gx-canvas-link-entry gx-z-canvas-entry absolute left-[36px] top-[36px]"
        // 阻止 plait 选中插件把这个工具条当成"画布空白"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          ref={btnRef}
          type="button"
          title="插入关联（文档 / 画布）"
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex h-8 items-center gap-1.5 rounded-gx-lg border border-gx-separator bg-gx-surface px-2.5 text-gx-12 font-medium shadow-lg transition-colors ${
            open
              ? "bg-gx-accent-bg text-gx-accent"
              : "text-gx-text-secondary hover:bg-gx-bg hover:text-gx-accent"
          }`}
        >
          <Icon name="link" size={14} />
          关联
        </button>
      </div>

      {/* popover 弹层（沿用 Popover 的 fixed 模式，自动计算锚点位置） */}
      <Popover open={open} onClose={() => setOpen(false)} fixed anchorEl={btnRef.current} width={320}>
        <InsertLinkBlockPicker
          anchor={{ x: 36, y: 36 }}
          currentDocId={currentDocId}
          onInsert={handlePick}
          onClose={() => setOpen(false)}
        />
      </Popover>

      {/* 新建/选择后立即弹编辑器。沿用 LinkBlockInserter 旧模式：用 ref 闭合以保证 link-block 已就位 */}
      {creating && kbId && (
        <EditorModal
          ref_={{
            docId: creating.docId,
            kind: creating.kind,
            title: creating.title,
          }}
          kbId={kbId}
          onClose={() => setCreating(null)}
          onSaved={() => {
            // EditorModal 内部已主动 invalidate useDoc 缓存，画布预览块下一次挂载时会拉到最新
          }}
        />
      )}
    </>
  );
}
