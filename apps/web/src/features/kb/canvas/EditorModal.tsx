// apps/web/src/features/kb/canvas/EditorModal.tsx
// 画布内嵌编辑器（不入路由）：新建文档/画布后立即弹出，让用户在画布上下文中直接编辑。
// 与 DocEditModal/CanvasEditModal 对称，但额外支持内联标题编辑与新建场景。
//
// 流程：
//   1. 用户点击工具条「新建文档/新建画布」→ useCreateDoc 创建 → insertLinkBlock 插入画布
//   2. 打开本 Modal → 标题默认取 doc.title（新建场景通常为「未命名文档/画布」）
//   3. 用户编辑标题与正文
//   4. 点击「保存」：标题走 useRenameDoc，内容走 KbApi.saveContent（沿用 DocEditModal 的 latest ref 模式）
//   5. 关闭 → 父级调用 onSaved → GxLinkBlockView 通过 refetch 重新拉取显示新内容

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "../../../components/icons";
import { Spinner, toast } from "../../../components/ui";
import { confirmDiscardChanges } from "../../../components/feedback";
import { KbApi } from "../../../api/client";
import { useRenameDoc } from "../kb-hooks";
import { useResolvedDoc } from "../hooks/useResolvedDoc";
import { useModalKeyboardGuard } from "../hooks/useModalKeyboardGuard";
import { MarkdownEditor } from "../MarkdownEditor";
import { DrawnixCanvas } from "../DrawnixCanvas";
import type { GxDocRef } from "./types";

export function EditorModal({
  ref_,
  kbId,
  onClose,
  onSaved,
}: {
  /** 要编辑的关联 ref（来自刚 useCreateDoc 拿到的新文档） */
  ref_: GxDocRef;
  /** 知识库 id（标题重命名需要） */
  kbId?: string;
  onClose: () => void;
  /** 保存成功后调用，父级用于触发画布预览块 refetch */
  onSaved: () => void;
}) {
  const { doc, isLoading, error } = useResolvedDoc(ref_.docId);
  const rename = useRenameDoc(ref_.docId, kbId ?? "");
  const qc = useQueryClient();

  // 标题：本地编辑态，失焦或 Enter 时 commit
  const [title, setTitle] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const modalRef = useRef<HTMLDivElement | null>(null);
  // Cmd/Ctrl+S 统一收口：仅保存本弹窗（含标题/正文），不穿透背景 Drawnix 触发 .drawnix 下载
  useModalKeyboardGuard(modalRef, true, () => {
    if (!saving && !isLoading && doc) void save();
  });
  // 正文：latest 引用，跟踪编辑器最新值（与 DocEditModal 风格一致）
  const latestContent = useRef<string>(doc?.content ?? "");

  // doc 加载到位时同步本地 title 与 latest
  useEffect(() => {
    if (doc) {
      setTitle(doc.title || ref_.title || "");
      latestContent.current = doc.content ?? "";
    }
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isCanvas = ref_.kind === "canvas";

  // C-6：关闭前确认。正文 dirty = latestContent 与已加载内容不同；
  // 标题 dirty = 输入框有未 blur 提交的非空改动（commitTitle 在 blur 时已保存）。
  //
  // 阶段 4：原生 window.confirm → feedback.tsx 的 confirmDiscardChanges（L2 普通确认）。
  // 原生 confirm 在自动化测试环境无 UI 实现会挂死，替换后关闭路径可被断言。
  const requestClose = useCallback(async () => {
    if (savingRef.current) return;
    const contentDirty = !isCanvas && !!doc && latestContent.current !== (doc.content ?? "");
    const titleDirty = !!doc && title.trim() !== "" && title.trim() !== doc.title;
    if (contentDirty || titleDirty) {
      const ok = await confirmDiscardChanges();
      if (!ok) return;
    }
    onClose();
  }, [onClose, isCanvas, doc, title]);

  // Esc 关闭（除非正在保存）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) void requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, saving]);

  /**
   * 修复 Issue 3（IME 组词丢失）：用 useCallback 稳定 onChange 引用，
   * 避免父级任一次重渲染（如 useDoc refetch / qc 状态变化）就让 MarkdownEditor
   * 整棵 useCallback 链重新创建，间接触发 Editable memo 失效 + useEffect 覆写 innerHTML。
   * IME 期间该覆写会摧毁 composition span，导致候选窗提前消失。
   */
  const handleEditorChange = useCallback((md: string) => {
    latestContent.current = md;
  }, []);

  async function commitTitle() {
    if (!doc) return;
    const next = title.trim();
    if (!next || next === doc.title) {
      setTitle(doc.title);
      return;
    }
    try {
      await rename.mutateAsync(next);
      toast("标题已更新", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "重命名失败", "error");
    }
  }

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      // 1. 标题（如有变更）
      const trimmedTitle = title.trim();
      if (trimmedTitle && doc && trimmedTitle !== doc.title) {
        await rename.mutateAsync(trimmedTitle);
      }
      // 2. 正文（仅 doc 类型走 MarkdownEditor；canvas 类型由 DrawnixCanvas 自管，正文暂不开放内联编辑）
      if (ref_.kind === "doc") {
        // S-1：携带读取时的版本号；409 由下方 catch 统一提示
        await KbApi.saveContent(ref_.docId, { content: latestContent.current, baseVersion: doc?.contentVersion });
        // 主动 invalidate，让 GxLinkBlockView 的 useDoc 立即拿到最新内容
        await qc.invalidateQueries({ queryKey: ["kb", "doc", ref_.docId] });
      }
      toast("已保存", "success");
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存失败", "error");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return createPortal(
    <div
      ref={modalRef}
      className="gx-z-canvas-modal fixed inset-0 flex items-center justify-center p-6"
    >
      <div className="absolute inset-0 bg-black/40" onClick={saving ? undefined : () => void requestClose()} />
      <div className="relative flex h-[86vh] w-[90vw] flex-col overflow-hidden rounded-gx-xl bg-gx-surface shadow-2xl">
        {/* 顶栏：内联标题 + 保存 / 关闭 */}
        <div className="flex items-center gap-2 border-b border-gx-separator px-4 py-2.5">
          <Icon
            name={isCanvas ? "canvas" : "doc"}
            size={16}
            className="shrink-0 text-gx-text-secondary"
          />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            placeholder={isCanvas ? "未命名画布" : "未命名文档"}
            className="min-w-0 flex-1 rounded-gx-sm bg-transparent px-1.5 py-1 text-gx-14 font-semibold text-gx-text-primary hover:bg-gx-bg focus:bg-gx-bg focus:outline-none disabled:opacity-60"
          />
          <button
            type="button"
            onClick={save}
            disabled={saving || isLoading || !doc}
            className="inline-flex h-8 items-center gap-1.5 rounded-gx-lg bg-gx-accent px-3 text-gx-12 font-medium text-white hover:brightness-95 disabled:opacity-50"
          >
            <Icon name="save" size={14} />
            {saving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            onClick={() => void requestClose()}
            disabled={saving}
            className="inline-flex h-8 items-center rounded-gx-lg border border-gx-border bg-gx-surface px-3 text-gx-12 text-gx-text-secondary hover:bg-gx-bg disabled:opacity-50"
          >
            关闭
          </button>
        </div>
        {/* 正文区 */}
        <div className="relative min-h-0 flex-1 bg-gx-surface">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner size={20} />
            </div>
          ) : error || !doc ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <Icon name="lock" size={22} className="text-gx-text-hint" />
              <div className="text-gx-13 font-medium text-gx-text-primary">无法打开该内容</div>
              <div className="max-w-sm text-gx-12 text-gx-text-hint">
                该内容可能刚创建但加载失败，或已被删除。请关闭重试。
              </div>
            </div>
          ) : isCanvas ? (
            // 画布类型：用只读 DrawnixCanvas 预览（内联编辑画布内容超出本任务范围，按设计契约引导用户去画布内编辑）
            <DrawnixCanvas content={doc.content} readonly allowViewInteraction />
          ) : (
            <MarkdownEditor
              key={`editor-${doc.id}`}
              initialMarkdown={doc.content ?? ""}
              onChange={handleEditorChange}
              docId={doc.id}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}