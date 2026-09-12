// apps/web/src/features/kb/canvas/NodeBadges.tsx
// 节点上的轻量角标层（#118 注释 / #119 关联文档）：
//  - 有注释：右上角小气泡，hover 显示浮卡（正文摘要 + 编辑），移开自动收起，画布保持清爽；
//  - 有关联：文档/画布图标角标，点击展开嵌入预览卡（DocRefCard，由 CanvasEnhanceOverlay 统一管理）；
//  - 角标随节点屏幕包围盒定位，缩放过小（<40%）自动隐藏，避免干扰。
// 只读用户可看角标与预览；编辑/删除入口按 canEdit 显隐。

import { useEffect, useRef, useState } from "react";
import type { PlaitElement } from "@plait/core";
import { Icon } from "../../../components/icons";
import { useCanvasBoard, type ScreenRect } from "./canvas-context";
import { readElementDocRef, readElementNote, setElementNote } from "./canvas-ops";
import { DocKindIcon } from "../kb-ui";

const BADGE = 18; // 角标尺寸 px

export function NodeBadges({
  element,
  rect,
  canEdit,
  onOpenRef,
  isRefOpen,
}: {
  element: PlaitElement;
  rect: ScreenRect;
  canEdit: boolean;
  onOpenRef: () => void;
  /** 该节点的关联预览卡是否正展开（用于角标 active 高亮，多开时标明卡片归属） */
  isRefOpen?: boolean;
}) {
  const rt = useCanvasBoard();
  const note = readElementNote(element);
  const docRef = readElementDocRef(element);
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note);
  const hideTimer = useRef(0);

  const zoom = rt?.board?.viewport?.zoom ?? 1;
  if (zoom < 0.4) return null;

  // 角标沿节点右上缘排列；连线挂在起点附近
  const baseX = rect.x + rect.width;
  const topY = rect.y - BADGE / 2;

  const enter = () => {
    clearTimeout(hideTimer.current);
    setHover(true);
  };
  const leave = () => {
    if (editing) return;
    hideTimer.current = window.setTimeout(() => setHover(false), 180);
  };

  function saveNote() {
    if (!rt?.board) return;
    const next = draft.trim();
    if (next !== note) setElementNote(rt.board, element, next);
    setEditing(false);
    rt.notify();
    rt.refreshSelection();
    if (!next) setHover(false);
  }

  return (
    <div
      className="pointer-events-none absolute gx-z-canvas-badge"
      style={{ left: baseX, top: topY }}
    >
      <div className="pointer-events-auto flex items-center gap-1" style={{ transform: "translateX(-100%)" }}>
        {docRef && (
          <button
            type="button"
            title={`关联${docRef.kind === "canvas" ? "画布" : "文档"}：${docRef.title}（点击预览）`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpenRef();
            }}
            className={`flex h-[18px] w-[18px] items-center justify-center rounded-full border shadow-sm transition-colors ${
              isRefOpen
                ? "border-gx-accent bg-gx-accent text-white ring-2 ring-gx-accent/30"
                : "border-gx-separator bg-gx-surface text-gx-accent hover:brightness-105"
            }`}
          >
            <DocKindIcon kind={docRef.kind} size={11} />
          </button>
        )}
        {note && (
          <div className="relative" onMouseEnter={enter} onMouseLeave={leave}>
            <button
              type="button"
              title="节点注释"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (canEdit) setEditing((v) => !v);
                else setHover((v) => !v);
              }}
              className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-gx-separator bg-gx-surface text-gx-warning shadow-sm hover:brightness-105"
            >
              <Icon name="comment" size={11} />
            </button>

            {hover && !editing && (
              <div
                className="absolute right-0 top-6 w-60 rounded-gx-md border border-gx-separator bg-gx-surface p-2.5 shadow-xl"
                onMouseEnter={enter}
                onMouseLeave={leave}
              >
                <div className="mb-1 flex items-center gap-1 text-gx-11 font-medium text-gx-text-hint">
                  <Icon name="comment" size={12} />
                  节点注释
                </div>
                <div className="whitespace-pre-wrap break-words text-gx-12 leading-relaxed text-gx-text-primary">
                  {note}
                </div>
                {canEdit && (
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); setDraft(note); setEditing(true); }}
                      className="inline-flex items-center gap-1 rounded-gx-sm px-2 py-1 text-gx-12 text-gx-accent hover:bg-gx-bg"
                    >
                      <Icon name="edit" size={12} />
                      直接编辑
                    </button>
                  </div>
                )}
              </div>
            )}

            {editing && canEdit && (
              <NoteInlineEditor
                draft={draft}
                setDraft={setDraft}
                onCancel={() => { setEditing(false); setDraft(note); }}
                onSave={saveNote}
                onDelete={() => {
                  if (!rt?.board) return;
                  setElementNote(rt.board, element, "");
                  setEditing(false);
                  setHover(false);
                  rt.notify();
                  rt.refreshSelection();
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NoteInlineEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  onDelete,
}: {
  draft: string;
  setDraft: (s: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      className="absolute right-0 top-6 w-64 rounded-gx-md border border-gx-separator bg-gx-surface p-2 shadow-xl"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        maxLength={500}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave();
          }
          if (e.key === "Escape") onCancel();
        }}
        className="w-full resize-none rounded-gx-sm border border-gx-border bg-gx-bg px-2 py-1.5 text-gx-12 text-gx-text-primary outline-none focus:border-gx-accent"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <button type="button" onClick={onDelete} className="text-gx-12 text-gx-text-tertiary hover:text-danger">
          删除
        </button>
        <div className="flex gap-1">
          <button type="button" onClick={onCancel} className="rounded-gx-sm px-2 py-1 text-gx-12 text-gx-text-tertiary hover:bg-gx-bg">
            取消
          </button>
          <button type="button" onClick={onSave} className="rounded-gx-sm bg-gx-accent px-2.5 py-1 text-gx-12 font-medium text-white hover:brightness-95">
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
