// apps/web/src/features/kb/canvas/DocEditModal.tsx
// 画布内关联文档的弹窗编辑器（#119，不离开当前画布即可编辑被引用文档）。
// 复用文档编辑器同款 MarkdownEditor，保存走 KbApi/PublicApi，与 CanvasEditModal 对称。
//
// KB-EDITOR-ROUND-5：
//   - 取数统一走 useResolvedDoc；
//   - createPortal 到 body + gx-z-canvas-modal；
//   - 捕获阶段键盘 guard 防 Plait window 委托吞字；
//   - onChange 用 useCallback 稳定引用（与 EditorModal 一致，防 IME 组词覆写）。

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../../components/icons";
import { Spinner, toast } from "../../../components/ui";
// 阶段 4：关闭确认从 window.confirm 换成 feedback 的 L2 确认（原生 confirm 在自动化测试环境会挂死）
import { confirmDiscardChanges } from "../../../components/feedback";
import { KbApi, PublicApi } from "../../../api/client";
import { useResolvedDoc } from "../hooks/useResolvedDoc";
import { useModalKeyboardGuard } from "../hooks/useModalKeyboardGuard";
import { MarkdownEditor } from "../MarkdownEditor";

export function DocEditModal({
  docId,
  publicToken,
  onClose,
  onSaved,
}: {
  docId: string;
  publicToken?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const r = useResolvedDoc(docId, { publicToken });
  const doc = r.doc;
  const isLoading = r.isLoading;
  const error = r.error;
  const latest = useRef<string>(doc?.content ?? "");
  const modalRef = useRef<HTMLDivElement | null>(null);
  // Cmd/Ctrl+S 在 window 捕获阶段统一收口到弹窗保存，阻止穿透到背景 Drawnix 触发 .drawnix 下载
  useModalKeyboardGuard(modalRef, true, () => {
    if (!saveDisabled) void save();
  });
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const handleEditorChange = useCallback((md: string) => {
    latest.current = md;
  }, []);

  // C-6：记录初始内容，关闭时若有未保存修改需确认（此前 Esc/遮罩/关闭按钮直接丢弃）
  const initialRef = useRef<string | null>(null);
  useEffect(() => {
    if (doc && initialRef.current === null) {
      initialRef.current = doc.content ?? "";
      latest.current = doc.content ?? "";
    }
  }, [doc]);
  // S-1：乐观锁版本——保存成功后跟进本地版本，避免同一弹窗二次保存假冲突
  const versionRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (doc?.contentVersion !== undefined) versionRef.current = doc.contentVersion;
  }, [doc?.contentVersion]);
  const requestClose = useCallback(async () => {
    if (savingRef.current) return;
    const dirty = initialRef.current !== null && latest.current !== initialRef.current;
    if (dirty) {
      const ok = await confirmDiscardChanges({ description: "文档有未保存的修改，关闭后不会保存。" });
      if (!ok) return;
    }
    onClose();
  }, [onClose]);

  // 公开引用闭包内文档只读（r.canEdit 恒 false）：禁用保存
  const saveDisabled = saving || isLoading || (!!publicToken && !r.canEdit);

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (publicToken) await PublicApi.saveContent(publicToken, docId, latest.current);
      else {
        const res = await KbApi.saveContent(docId, { content: latest.current, baseVersion: versionRef.current });
        if (res.contentVersion != null) versionRef.current = res.contentVersion;
      }
      // 保存成功后以当前内容为新的未修改基线（requestClose 不再误报脏）
      initialRef.current = latest.current;
      toast("文档已保存", "success");
      onSaved();
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
      onKeyDown={(e) => {
        if (e.key === "Escape" && !saving) void requestClose();
      }}
    >
      <div className="absolute inset-0 bg-black/40" onClick={saving ? undefined : () => void requestClose()} />
      <div className="relative flex h-[86vh] w-[90vw] flex-col overflow-hidden rounded-gx-xl bg-gx-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-gx-separator px-4 py-2.5">
          <Icon name="doc" size={16} className="text-gx-text-secondary" />
          <span className="min-w-0 flex-1 truncate text-gx-14 font-semibold text-gx-text-primary">
            {doc?.title || "未命名文档"}
          </span>
          <button
            type="button"
            onClick={save}
            disabled={saveDisabled}
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
        <div className="relative min-h-0 flex-1 bg-gx-surface">
          {isLoading ? (
            <div className="flex h-full items-center justify-center"><Spinner size={20} /></div>
          ) : error || !doc ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <Icon name="lock" size={22} className="text-gx-text-hint" />
              <div className="text-gx-13 font-medium text-gx-text-primary">无法打开该文档</div>
              <div className="max-w-sm text-gx-12 text-gx-text-hint">
                {publicToken
                  ? "该文档未包含在当前分享范围内，或已被删除。请联系分享者确认。"
                  : "你没有该文档的访问权限，或文档已被删除。"}
              </div>
            </div>
          ) : (
            <MarkdownEditor
              initialMarkdown={doc.content ?? ""}
              onChange={handleEditorChange}
              publicToken={publicToken}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
