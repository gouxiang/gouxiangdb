// apps/web/src/features/kb/canvas/NoteEditorPopover.tsx
// 节点注释编辑弹层（#118）：无注释时可添加，有注释时可编辑/清空。
// 写入走 setElementNote（标准 set_node op，进撤销栈、随画布 JSON 保存）。
// 交互：Enter 保存，Esc/点外部关闭（有改动自动保存），清空全部文字并保存 = 删除注释。

import { useEffect, useRef, useState } from "react";
import type { PlaitElement } from "@plait/core";
import { Icon } from "../../../components/icons";
import { useCanvasBoard } from "./canvas-context";
import { readElementNote, setElementNote } from "./canvas-ops";
import { PopoverShell } from "./style-popups";

export function NoteEditorPopover({
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
  const initial = readElementNote(element);
  const [text, setText] = useState(initial);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const savedRef = useRef(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(text.length, text.length);
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function save() {
    if (!rt?.board || savedRef.current) {
      onClose();
      return;
    }
    savedRef.current = true;
    const next = text.trim();
    if (next !== initial) setElementNote(rt.board, element, next);
    // 命令写入后立即刷新选区与 overlay（自定义字段 setNode 不保证驱动 overlay frame）
    rt.notify();
    rt.refreshSelection();
    onClose();
  }

  return (
    <PopoverShell x={x} y={y} width={260} onClose={save}>
      <div className="mb-1.5 flex items-center gap-1.5 text-gx-12 font-medium text-gx-text-secondary">
        <Icon name="comment" size={14} />
        节点注释
      </div>
      <textarea
        ref={taRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        rows={4}
        maxLength={500}
        placeholder="给这个节点加一条注释，悬停节点即可查看…"
        className="w-full resize-none rounded-gx-sm border border-gx-border bg-gx-bg px-2 py-1.5 text-gx-12 text-gx-text-primary outline-none focus:border-gx-accent"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-gx-11 text-gx-text-hint">{text.length}/500</span>
        <div className="flex items-center gap-1">
          {initial && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                if (rt?.board) {
                  setElementNote(rt.board, element, "");
                  rt.notify();
                  rt.refreshSelection();
                }
                savedRef.current = true;
                onClose();
              }}
              className="rounded-gx-sm px-2 py-1 text-gx-12 text-gx-text-tertiary hover:bg-gx-bg hover:text-danger"
            >
              删除注释
            </button>
          )}
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={save}
            className="rounded-gx-sm bg-gx-accent px-2.5 py-1 text-gx-12 font-medium text-white hover:brightness-95"
          >
            保存
          </button>
        </div>
      </div>
    </PopoverShell>
  );
}
