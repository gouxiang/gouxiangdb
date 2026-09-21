// apps/web/src/features/kb/canvas/LinkBlockPreview.tsx
// 统一的关联嵌入预览卡（KB-EDITOR-ROUND-4 §2.2）。
//
// 两类调用点共用同一组件：
//   - 独立块 GxLinkBlockView（gx-link-block，z-60，plait points 决定尺寸）
//   - 节点角标 DocRefCard（gxDocRef，z-68，localStorage 决定尺寸）
//
// 容器定位由 caller 通过 containerClassName / containerStyle 决定（position/z-index/border/shadow）。
// 按钮集由 caller 通过对应 callback 决定存在性 —— 标题旁的"本地重命名"、"刷新"、"删除"
// 仅独立块会传；"关闭"仅角标卡会传；"跳转/编辑"在两场景均存在。
//
// 设计细节：
//   - 内联重命名：仅当 canRename=true 时显示 edit 图标 → 点击变 input → onBlur / Enter 调 onRename
//   - 跳转在无 kbId 时（公开分享无 kbId）通过 jumpEnabled=false 隐藏
//   - 极简预览（previewType="minimal"）只渲染 header，不渲染 body
//   - trailingNode：可选附加尾部节点（典型为右下角 resize 手柄），插入到容器内

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../../../components/icons";
import { DocKindIcon } from "../kb-ui";
import type { GxRefKind } from "./types";

export interface LinkBlockPreviewProps {
  /** 关联目标类型：文档 / 画布 / 数据表（数据表只影响图标与标题语义） */
  kind: GxRefKind;
  /** 显示标题（含本地 displayTitle 覆盖层） */
  title: string;
  canEdit: boolean;
  /** 仅独立块：标题可内联重命名（写本地 displayTitle，不动源文档） */
  canRename?: boolean;
  onRename?: (newTitle: string) => void;
  /** 公开分享场景没有 kbId 时禁止跳转 */
  jumpEnabled?: boolean;
  /** 统一跳转 */
  onJump: () => void;
  /** 统一打开 DocEditModal / CanvasEditModal（独立块 + 角标卡均有此能力） */
  onEdit?: () => void;
  /** 仅独立块：触发 useDoc refetch + qc invalidate */
  onRefresh?: () => void;
  /** 仅独立块：removeLinkBlock */
  onDelete?: () => void;
  /** 仅角标卡：关闭预览 */
  onClose?: () => void;
  /** 预览密度：minimal 仅渲染 header，无 body */
  previewType?: "full" | "minimal";
  /** body 节点（caller 自绘：摘要/markdown/canvas 只读；full 时显示） */
  body?: ReactNode;
  /** 外层容器 className（caller 自定：fixed 定位、z-index、shadow、圆角等） */
  containerClassName?: string;
  containerStyle?: CSSProperties;
  /** 容器内附加尾部节点（通常为右下角 resize 手柄） */
  trailingNode?: ReactNode;
  /** 透传到容器 div（data-* / aria-*） */
  dataAttrs?: Record<string, string>;
  /**
   * 容器级 pointer-down 拦截。
   * 给画布场景用：阻止事件冒泡到 plait 容器导致选中清空。
   * 角标/独立块都必须传 e.stopPropagation()。
   */
  onContainerPointerDown?: (e: React.PointerEvent) => void;
  /** 容器级双击（用于独立块"双击跳转"能力） */
  onContainerDoubleClick?: (e: React.MouseEvent) => void;
  /**
   * header 根条 pointer-down（用于独立块"按住头部拖拽移动"）。
   * 仅独立块传入；节点关联卡跟随节点，不提供拖拽。命中按钮/输入框时由调用方自行忽略。
   */
  onHeaderPointerDown?: (e: React.PointerEvent) => void;
}

interface HeaderProps {
  kind: GxRefKind;
  title: string;
  canEdit: boolean;
  canRename?: boolean;
  onRename?: (newTitle: string) => void;
  jumpEnabled: boolean;
  onJump: () => void;
  onEdit?: () => void;
  onRefresh?: () => void;
  onDelete?: () => void;
  onClose?: () => void;
  /**
   * header 根条 pointer-down（独立块"按住头部拖拽移动"）。
   * 仅当独立块可编辑时传入；命中按钮/输入框由调用方在事件内忽略。
   */
  onHeaderPointerDown?: (e: React.PointerEvent) => void;
}

function LinkBlockPreviewHeader({
  kind,
  title,
  canEdit,
  canRename,
  onRename,
  jumpEnabled,
  onJump,
  onEdit,
  onRefresh,
  onDelete,
  onClose,
  onHeaderPointerDown,
}: HeaderProps) {
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function commitRename() {
    setRenaming(false);
    const next = renameVal.trim();
    if (next === title) return;
    onRename?.(next);
  }

  return (
    <div
      onPointerDown={onHeaderPointerDown}
      className={`flex h-8 shrink-0 select-none items-center gap-1.5 border-b border-gx-separator bg-gx-surface px-2 ${
        onHeaderPointerDown ? "cursor-grab active:cursor-grabbing" : ""
      }`}
    >
      <DocKindIcon kind={kind} size={14} />
      {renaming ? (
        <input
          ref={inputRef}
          autoFocus
          value={renameVal}
          onChange={(e) => setRenameVal(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setRenameVal(title);
              setRenaming(false);
            }
          }}
          placeholder="重命名…"
          className="min-w-0 flex-1 rounded-gx-sm bg-gx-bg px-1.5 py-0.5 text-gx-13 font-medium text-gx-text-primary outline-none focus:ring-2 focus:ring-gx-accent-bg"
        />
      ) : (
        <span
          className="min-w-0 flex-1 truncate text-gx-13 font-medium text-gx-text-primary"
          title={title}
        >
          {title}
        </span>
      )}
      {canEdit && canRename && !renaming && (
        <button
          type="button"
          title="本地重命名（不影响源文档）"
          onClick={() => {
            setRenameVal(title);
            setRenaming(true);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-gx-text-hint hover:bg-gx-bg hover:text-gx-accent"
        >
          <Icon name="edit" size={12} />
        </button>
      )}
      {jumpEnabled && (
        <button
          type="button"
          title="跳转到目标"
          onClick={onJump}
          className="inline-flex h-6 items-center gap-1 rounded-gx-sm border border-gx-border px-1.5 text-gx-11 text-gx-text-secondary hover:bg-gx-bg"
        >
          <Icon name="external" size={12} />
          跳转
        </button>
      )}
      {onEdit && canEdit && (
        <button
          type="button"
          title="弹窗内编辑（不离开画布）"
          onClick={onEdit}
          className="inline-flex h-6 items-center gap-1 rounded-gx-sm bg-gx-accent px-2 text-gx-11 font-medium text-white hover:brightness-95"
        >
          <Icon name="edit" size={12} />
          编辑
        </button>
      )}
      {onRefresh && (
        <button
          type="button"
          title="刷新源标题与摘要"
          onClick={onRefresh}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-gx-text-hint hover:bg-gx-bg hover:text-gx-accent"
        >
          <Icon name="refresh" size={12} />
        </button>
      )}
      {onDelete && canEdit && (
        <button
          type="button"
          title="删除关联块"
          onClick={onDelete}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-gx-text-hint hover:bg-gx-bg hover:text-danger"
        >
          <Icon name="trash" size={13} />
        </button>
      )}
      {onClose && (
        <button
          type="button"
          title="收起预览"
          onClick={onClose}
          className="inline-flex h-6 w-6 items-center justify-center rounded-gx-sm text-gx-text-tertiary hover:bg-gx-bg"
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

export function LinkBlockPreview(props: LinkBlockPreviewProps) {
  const {
    previewType = "full",
    body,
    containerClassName,
    containerStyle,
    trailingNode,
    dataAttrs,
    onContainerPointerDown,
    onContainerDoubleClick,
    ...header
  } = props;
  const minimal = previewType === "minimal";
  return (
    <div
      className={containerClassName}
      style={containerStyle}
      onPointerDown={onContainerPointerDown}
      onDoubleClick={onContainerDoubleClick}
      {...dataAttrs}
    >
      <LinkBlockPreviewHeader {...header} jumpEnabled={header.jumpEnabled ?? true} />
      {!minimal && body}
      {trailingNode}
    </div>
  );
}
