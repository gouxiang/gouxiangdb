// apps/web/src/features/kb/canvas/CanvasLinkPicker.tsx
// 统一关联选择弹层（KB-EDITOR-ROUND-4 §1.2.2）：
//  - 替代 LinkBlockPicker（LinkBlockInserter 旧组件）+ DocRefPickerPopover 的列表部分；
//  - 两类调用场景由 mode 决定（"standalone" = 插入独立块；"attach" = 给现有元素挂 gxDocRef）；
//  - 文档 / 画布用并排两个按钮 + 内联标题输入，差异仅 kind 字段；
//  - 包含并排搜索 + 类型 tab（保留 LinkBlockPicker 的 tab，方便过滤）。
//
// 容器外壳由 caller 提供（CanvasLinkEntry 走 Popover；DocRefPickerPopover 走 PopoverShell），
// 故本组件只负责内容布局，不处理定位 / 点击外部关闭。

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../../components/icons";
import { toast } from "../../../components/ui";
import { DocKindIcon } from "../kb-ui";
import { useCanvasBoard } from "./canvas-context";
import { setElementDocRef, readElementDocRef } from "./canvas-ops";
import { useCreateDoc, useKbDocs } from "../kb-hooks";
import { insertLinkBlock } from "./canvas-ops";
import type { KbDocKind } from "../../../api/client";
import type { GxDocRef, GxShapeElement } from "./types";

export type PreviewType = "full" | "minimal";
type FilterKind = "all" | "doc" | "canvas";

export interface CanvasLinkPickerProps {
  /** 关闭回调（创建 / 选择 / Esc / 点击外部由 caller 触发） */
  onClose: () => void;
  /** 触发位置（caller 用来弹层对齐；本组件不直接用） */
  anchor: { x: number; y: number };
  /** 当前文档 id（用于排除自身） */
  currentDocId?: string;
  /** 选中模式 */
  mode: "standalone" | "attach";

  /** standalone 模式必传：把选中的 ref 插入为 link-block */
  onPickStandalone?: (
    docId: string,
    kind: KbDocKind,
    title: string,
    previewType?: PreviewType,
  ) => void;
  /** attach 模式必传：把 ref 写入 element.gxDocRef */
  onPickAttach?: (docId: string, kind: KbDocKind, title: string) => void;

  /** attach 模式必传：当前元素 */
  attachElement?: GxShapeElement;
  /** attach 模式：当前是否已挂 ref（控制"取消关联"按钮显隐） */
  attachHasRef?: boolean;
  /** attach 模式：清空 element.gxDocRef */
  onAttachClear?: () => void;

  /** standalone 模式：是否显示"预览类型" radio；attach 模式恒为 false */
  showPreviewType?: boolean;
}

export function CanvasLinkPicker(props: CanvasLinkPickerProps) {
  const {
    onClose,
    currentDocId,
    mode,
    onPickStandalone,
    onPickAttach,
    attachElement,
    attachHasRef,
    onAttachClear,
    showPreviewType = false,
  } = props;

  const rt = useCanvasBoard();
  const kbId = rt?.ctx.kbId;
  // 内部页才支持选择；公开分享页显示无 kb 列表提示
  const canFetch = !rt?.ctx.publicToken && !!kbId;
  const { data: docs } = useKbDocs(canFetch ? kbId : undefined, "all");

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");
  const [previewType, setPreviewType] = useState<PreviewType>("full");
  const [creating, setCreating] = useState<null | "doc" | "canvas">(null);

  const items = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (docs ?? [])
      .filter((d) => !d.deletedAt && d.id !== currentDocId)
      .filter((d) => filter === "all" || d.kind === filter)
      .filter((d) => !kw || d.title.toLowerCase().includes(kw))
      .slice(0, 30);
  }, [docs, q, filter, currentDocId]);

  const tabs: { value: FilterKind; label: ReactNode; icon: IconName }[] = [
    { value: "all", label: "全部", icon: "link" },
    { value: "doc", label: "文档", icon: "doc" },
    { value: "canvas", label: "画布", icon: "canvas" },
  ];

  function pickExisting(docId: string, kind: KbDocKind, title: string) {
    if (mode === "standalone") {
      onPickStandalone?.(docId, kind, title, previewType);
    } else {
      onPickAttach?.(docId, kind, title);
    }
    onClose();
  }

  function handleAttachClear() {
    onAttachClear?.();
    onClose();
  }

  // Esc 关闭由 caller 的容器处理（Popover/PopoverShell 均已自带）；
  // 这里不重复绑定（避免双绑产生竞态）。
  return (
    <div>
      {/* 搜索 + 类型 tab */}
      <div className="border-b border-gx-separator p-2">
        <div className="relative">
          <Icon name="search" size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gx-text-hint" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索文档或画布…"
            className="w-full rounded-gx-sm bg-gx-bg py-1.5 pl-7 pr-2 text-gx-13 text-gx-text-primary outline-none placeholder:text-gx-text-hint focus:bg-gx-surface"
          />
        </div>
        <div className="mt-1.5 flex gap-0.5 rounded-gx-sm bg-gx-bg p-0.5">
          {tabs.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setFilter(t.value)}
              className={`flex flex-1 items-center justify-center gap-1 rounded-gx-sm py-1 text-gx-11 font-medium transition-colors ${
                filter === t.value ? "bg-gx-surface text-gx-text-primary shadow-sm" : "text-gx-text-tertiary hover:text-gx-text-secondary"
              }`}
            >
              <Icon name={t.icon} size={11} />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 列表 */}
      {!canFetch ? (
        <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">
          分享页暂不支持新建关联，仅可查看已有关联。
        </div>
      ) : items.length === 0 ? (
        <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">无匹配结果</div>
      ) : (
        <div className="max-h-64 overflow-y-auto py-1">
          {items.map((d) => {
            // attach 模式对当前已选中的项加高亮 + 对勾
            const isCurrent = mode === "attach" && attachHasRef && attachElement
              && (readElementDocRef(attachElement)?.docId === d.id);
            return (
              <button
                key={d.id}
                type="button"
                onClick={() => pickExisting(d.id, d.kind, d.title || "未命名")}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-gx-accent-bg ${
                  isCurrent ? "text-gx-accent" : "text-gx-text-primary"
                }`}
              >
                <DocKindIcon kind={d.kind} size={14} />
                <span className="min-w-0 flex-1 truncate text-gx-13">{d.title || "未命名"}</span>
                {isCurrent && <Icon name="check" size={13} />}
                {!isCurrent && <Icon name="plus" size={13} className="text-gx-text-hint" />}
              </button>
            );
          })}
        </div>
      )}

      {/* 创建入口：并排两个按钮（文档 / 画布） */}
      <div className="flex items-center gap-1.5 border-t border-gx-separator px-2.5 py-2">
        <button
          type="button"
          onClick={() => setCreating("doc")}
          disabled={!canFetch || creating !== null}
          className="flex flex-1 items-center justify-center gap-1 rounded-gx-sm border border-gx-border py-1 text-gx-12 text-gx-text-secondary hover:bg-gx-bg disabled:opacity-50"
        >
          <Icon name="plus" size={12} />
          新建文档
        </button>
        <button
          type="button"
          onClick={() => setCreating("canvas")}
          disabled={!canFetch || creating !== null}
          className="flex flex-1 items-center justify-center gap-1 rounded-gx-sm border border-gx-border py-1 text-gx-12 text-gx-text-secondary hover:bg-gx-bg disabled:opacity-50"
        >
          <Icon name="plus" size={12} />
          新建画布
        </button>
      </div>

      {/* 内联创建表单（creating 非空时显示） */}
      {creating && (
        <CreateInlineForm
          kind={creating}
          onCancel={() => setCreating(null)}
          onCreated={(docId, title) => {
            if (mode === "standalone") {
              onPickStandalone?.(docId, creating, title, previewType);
            } else {
              onPickAttach?.(docId, creating, title);
            }
            onClose();
          }}
        />
      )}

      {/* 独立块场景：预览密度 radio */}
      {mode === "standalone" && showPreviewType && (
        <div className="border-t border-gx-separator px-2.5 py-2">
          <div className="mb-1 text-gx-11 text-gx-text-hint">预览类型</div>
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 text-gx-12 text-gx-text-secondary">
              <input
                type="radio"
                name="previewType"
                checked={previewType === "full"}
                onChange={() => setPreviewType("full")}
                className="accent-gx-accent"
              />
              完整预览
            </label>
            <label className="flex items-center gap-1.5 text-gx-12 text-gx-text-secondary">
              <input
                type="radio"
                name="previewType"
                checked={previewType === "minimal"}
                onChange={() => setPreviewType("minimal")}
                className="accent-gx-accent"
              />
              极简预览
            </label>
          </div>
        </div>
      )}

      {/* attach 模式：取消关联 */}
      {mode === "attach" && attachHasRef && (
        <button
          type="button"
          onClick={handleAttachClear}
          className="w-full rounded-gx-sm px-2 py-1.5 text-center text-gx-12 text-gx-text-tertiary hover:bg-gx-bg hover:text-danger border-t border-gx-separator"
        >
          取消关联
        </button>
      )}
    </div>
  );
}

/* ============================================================
 * 创建文档 / 画布内联表单（合并 LinkBlockInserter 的 NewDocForm）
 * 简化版：与 picker 内嵌；只关心 kbId 与 pickExisting 调用方
 * ============================================================ */
function CreateInlineForm({
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

/* ============================================================
 * 便捷封装：把 CanvasLinkPicker 接成 LinkBlockInserter 的旧 onPick 回调。
 * 给独立块场景直接用，外部只关心 onPickRef 即可。
 * ============================================================ */
export interface InsertLinkBlockPickerProps {
  /** 触发位置（caller 用来 popover 对齐） */
  anchor: { x: number; y: number };
  currentDocId?: string;
  /** 已选则调 insertLinkBlock（previewType 由 picker 内部 state 决定） */
  onInsert: (docId: string, kind: KbDocKind, title: string, previewType: PreviewType) => void;
  onClose: () => void;
}
export function InsertLinkBlockPicker(props: InsertLinkBlockPickerProps) {
  // 直接转发至 mode="standalone"。picker 内部始终给出 previewType（非可选），
  // 故此处 onPickStandalone 用强制类型避免 React 类型推断把可选参数拉低。
  return (
    <CanvasLinkPicker
      mode="standalone"
      anchor={props.anchor}
      currentDocId={props.currentDocId}
      onClose={props.onClose}
      showPreviewType
      onPickStandalone={(docId, kind, title, previewType) =>
        props.onInsert(docId, kind, title, previewType ?? "full")
      }
    />
  );
}

/* ============================================================
 * 便捷封装：把 CanvasLinkPicker 接成给现有元素挂 ref 的回调。
 * ============================================================ */
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
      onPickAttach={(docId, kind, title) => {
        if (!rt?.board) return;
        // 切换到新目标时：身份字段（docId/kind/title）一律用新选择；
        // 只沿用与目标无关的布局偏好 previewType（完整/极简）。
        // displayTitle 是针对旧目标的本地改名，切目标必须丢弃，否则新关联顶着旧标题。
        const ref: GxDocRef = {
          docId,
          kind,
          title,
          ...(existing?.previewType ? { previewType: existing.previewType } : {}),
        };
        setElementDocRef(rt.board, props.element, ref);
        // setNode 改自定义字段后显式 notify 一次，确保角标/样式条关联态即时刷新
        // （不依赖 plait 是否为该 op 派发 onChange；rAF 合帧，重复调用幂等）。
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

/** 把一个 GxShapeElement 安全转型为本模块期待的类型（运行时由 caller 保证） */
export function pickRefAsShape(el: GxShapeElement): GxShapeElement {
  return el;
}

/** 同样便捷导出 insertLinkBlock，便于一次性 import */
export { insertLinkBlock };
