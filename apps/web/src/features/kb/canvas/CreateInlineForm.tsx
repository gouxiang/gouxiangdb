// apps/web/src/features/kb/canvas/CreateInlineForm.tsx
// 关联选择器里的「新建文档 / 新建画布」内联表单。
// 从 CanvasLinkPicker.tsx 抽出（该文件已超 300 行门禁），逻辑一字未改。

import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../components/icons";
import { toast } from "../../../components/ui";
import { useCanvasBoard } from "./canvas-context";
import { useCreateDoc } from "../kb-hooks";
import type { KbDocKind } from "../../../api/client";

export function CreateInlineForm({
  kind,
  onCancel,
  onCreated,
}: {
  kind: KbDocKind;
  onCancel: () => void;
  onCreated: (docId: string, title: string) => void;
}) {
  const rt = useCanvasBoard();
  const kbId = rt?.ctx.kbId;
  const createDoc = useCreateDoc(kbId ?? "");

  const [title, setTitle] = useState(kind === "canvas" ? "未命名画布" : "未命名文档");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(id);
  }, []);

  if (!kbId) return null;

  async function run() {
    const t = title.trim();
    if (!t) return;
    setSubmitting(true);
    try {
      const res = await createDoc.mutateAsync({ kind, title: t });
      onCreated(res.doc.id, t);
    } catch (e) {
      toast(e instanceof Error ? e.message : "新建失败", "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="border-t border-gx-separator p-3">
      <div className="mb-2 flex items-center gap-1.5 text-gx-12 font-medium text-gx-text-secondary">
        <Icon name={kind === "canvas" ? "canvas" : "doc"} size={14} />
        {kind === "canvas" ? "新建画布" : "新建文档"}
      </div>
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !submitting) {
            e.preventDefault();
            void run();
          }
          if (e.key === "Escape") onCancel();
        }}
        placeholder={kind === "canvas" ? "画布标题" : "文档标题"}
        className="w-full rounded-gx-sm border border-gx-border bg-gx-bg px-2 py-1.5 text-gx-13 text-gx-text-primary outline-none focus:border-gx-accent"
      />
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="inline-flex h-7 items-center rounded-gx-sm px-2.5 text-gx-12 text-gx-text-tertiary hover:bg-gx-bg disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void run()}
          disabled={submitting || !title.trim()}
          className="inline-flex h-7 items-center gap-1 rounded-gx-sm bg-gx-accent px-2.5 text-gx-12 font-medium text-white hover:brightness-95 disabled:opacity-50"
        >
          {submitting ? "创建中…" : "创建并选择"}
        </button>
      </div>
    </div>
  );
}
