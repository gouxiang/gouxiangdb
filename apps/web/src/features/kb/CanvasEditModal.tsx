// apps/web/src/features/kb/CanvasEditModal.tsx
// 画布内嵌编辑弹窗：不离开当前文档即可编辑被引用的画布。
// 保存调用 KbApi/PublicApi，成功后 onSaved 由调用方（RefEmbedCard / CanvasEmbed）触发刷新。
//
// KB-EDITOR-ROUND-5：
//   - 取数统一走 useResolvedDoc（卡 / 弹窗共享缓存键）；
//   - createPortal 到 body + gx-z-canvas-modal，脱离画布堆叠上下文；
//   - 捕获阶段键盘 guard：可编辑元素内按键截断冒泡，防背后 Plait board window 委托吞字。

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/icons";
import { Spinner, toast } from "../../components/ui";
// 阶段 4：关闭确认从 window.confirm 换成 feedback 的 L2 确认（原生 confirm 在自动化测试环境会挂死）
import { confirmDiscardChanges } from "../../components/feedback";
import { KbApi } from "../../api/client";
import { useResolvedDoc } from "./hooks/useResolvedDoc";
import { useModalKeyboardGuard } from "./hooks/useModalKeyboardGuard";
import { GxCanvas } from "./canvas/GxCanvas";

export function CanvasEditModal({
  docId,
  onClose,
  onSaved,
  publicToken,
  kbId,
  canEdit: canEditProp,
}: {
  docId: string;
  onClose: () => void;
  onSaved: () => void;
  /** 公开分享页编辑：走匿名 PublicApi */
  publicToken?: string;
  /** 所属知识库 id：透传给嵌套画布增强层（关联选择/跳转等需要） */
  kbId?: string;
  /** 调用方已算好的可编辑性；缺省时回退为 r.canEdit（数据通道权限） */
  canEdit?: boolean;
}) {
  const r = useResolvedDoc(docId, { publicToken });
  const doc = r.doc;
  const isLoading = r.isLoading;
  const error = r.error;
  const modalRef = useRef<HTMLDivElement | null>(null);
  // 弹窗内嵌套画布的可编辑性：显式传入优先，否则按数据通道 r.canEdit。
  // 公开分享一律只读——匿名写端点已下线，r.canEdit 也恒 false，
  // 但这里再压一道：不依赖后端字段也能保证「分享页没有编辑态」。
  const canEdit = publicToken ? false : (canEditProp ?? r.canEdit);
  // 统一保存作用域：无论焦点在弹窗画布内还是顶栏，Cmd/Ctrl+S 只保存本弹窗、不穿透背景画布
  useModalKeyboardGuard(modalRef, true, () => {
    if (!saveDisabled) void save();
  });
  const latest = useRef<string>(doc?.content ?? "[]");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // S-1：乐观锁版本——保存成功后跟进本地版本，避免同一弹窗二次保存假冲突
  const versionRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (doc?.contentVersion !== undefined) versionRef.current = doc.contentVersion;
  }, [doc?.contentVersion]);
  // C-6：画布内容脏标记。GxCanvas 的 onContentChange 有 lastEmitted 去重（初始挂载不触发），
  // 回调触发即代表用户真实修改过；关闭时据此确认，避免 Esc/遮罩直接丢弃未保存内容。
  const dirtyRef = useRef(false);
  const requestClose = async () => {
    if (savingRef.current) return;
    if (dirtyRef.current) {
      const ok = await confirmDiscardChanges({ description: "画布有未保存的修改，关闭后不会保存。" });
      if (!ok) return;
    }
    onClose();
  };

  // 无编辑权限（公开引用闭包内只读 r.canEdit=false，或外层显式只读）：禁用保存
  const saveDisabled = saving || isLoading || !canEdit;

  async function save() {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      // 公开分享没有写端点（saveDisabled 已挡住入口），这里只保留内部态一条通道。
      const res = await KbApi.saveContent(docId, { content: latest.current, baseVersion: versionRef.current });
      if (res.contentVersion != null) versionRef.current = res.contentVersion;
      // 保存成功后清脏标记（requestClose 不再误报）
      dirtyRef.current = false;
      toast("画布已保存", "success");
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
        {/* 顶栏 */}
        <div className="flex items-center gap-2 border-b border-gx-separator px-4 py-2.5">
          <Icon name="canvas" size={16} className="text-gx-text-secondary" />
          <span className="min-w-0 flex-1 truncate text-gx-14 font-semibold text-gx-text-primary">
            {doc?.title || "未命名画布"}
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
        {/* 画布 */}
        <div className="relative min-h-0 flex-1 bg-white">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner size={20} />
            </div>
          ) : error || !doc ? (
            // 明确的不可编辑触发条件：无访问权限 / 已删除 / 不在分享子树 / 加载失败。
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <Icon name="lock" size={22} className="text-gx-text-hint" />
              <div className="text-gx-13 font-medium text-gx-text-primary">无法打开该画布</div>
              <div className="max-w-sm text-gx-12 text-gx-text-hint">
                {publicToken
                  ? "该画布未包含在当前分享范围内，或已被删除。请联系分享者确认。"
                  : "你没有该画布的访问权限，或画布已被删除。"}
              </div>
            </div>
          ) : (
            // 嵌套编辑画布走统一装配 GxCanvas：与主画布同一套增强能力（关联块/注释角标/
            // 样式条/插入入口），未来画布新能力自动生效，不再出现"嵌套画布是最初始功能"。
            <GxCanvas
              docId={docId}
              content={doc.content}
              canEdit={canEdit}
              kbId={kbId}
              publicToken={publicToken}
              onContentChange={(json) => { latest.current = json; dirtyRef.current = true; }}
              onSave={() => void save()}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
