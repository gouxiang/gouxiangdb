// apps/web/src/features/kb/canvas/CanvasLinkPicker.tsx
// 统一关联选择弹层（KB-EDITOR-ROUND-4 §1.2.2）：
//  - 两类调用场景由 mode 决定（"standalone" = 插入独立块；"attach" = 给现有元素挂 gxDocRef）；
//  - 数据源是 GET /api/linkable —— **后端已按库权限过滤**，前端拿到什么就能关联什么；
//    因此这里没有、也不该有任何「可见性判断」。
//  - 类型 tab：全部 / 文档 / 画布 / 数据表；数据表点开后先选视图（网格/看板/画廊/日历…）。
//  - 新建文档 / 新建画布的内联表单在 CreateInlineForm.tsx；结果列表在 LinkableResultList.tsx。

import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../../components/icons";
import { useCanvasBoard } from "./canvas-context";
import { readElementDocRef } from "./canvas-ops";
import { useLinkable } from "./linkable-hooks";
import { CreateInlineForm } from "./CreateInlineForm";
import { LinkableResultList } from "./LinkableResultList";
import type { KbDocKind, LinkableItem, LinkableType } from "../../../api/client";
import type { GxShapeElement } from "./types";
import type { PickResult, PreviewType } from "./link-picker-types";

export type { PreviewType, PickResult } from "./link-picker-types";

type FilterKind = "all" | "doc" | "canvas" | "table";

/**
 * tab → types 查询参数。
 * 「全部」只取三类**可作关联目标**的类型（doc/canvas/table）：
 * base/kb 是「库」本身，GxDocRef.kind 表达不了，插不出关联块。
 */
const FILTER_TYPES: Record<FilterKind, LinkableType[]> = {
  all: ["doc", "canvas", "table"],
  doc: ["doc"],
  canvas: ["canvas"],
  table: ["table"],
};

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
  onPickStandalone?: (ref: PickResult, previewType: PreviewType) => void;
  /** attach 模式必传：把 ref 写入 element.gxDocRef */
  onPickAttach?: (ref: PickResult) => void;

  /** attach 模式：当前元素（用于给「已选中的那一条」加高亮） */
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

  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<FilterKind>("all");
  const [previewType, setPreviewType] = useState<PreviewType>("full");
  const [creating, setCreating] = useState<null | KbDocKind>(null);

  const { data, isLoading, isError } = useLinkable({
    q,
    types: FILTER_TYPES[filter],
    limit: 50,
    enabled: canFetch,
  });

  // 只排除自身（不允许把当前画布关联给自己）；搜索/类型过滤都在服务端做。
  const items = (data?.items ?? []).filter((it) => it.id !== currentDocId);

  const tabs: { value: FilterKind; label: ReactNode; icon: IconName }[] = [
    { value: "all", label: "全部", icon: "link" },
    { value: "doc", label: "文档", icon: "doc" },
    { value: "canvas", label: "画布", icon: "canvas" },
    { value: "table", label: "数据表", icon: "table" },
  ];

  function pick(ref: PickResult) {
    if (mode === "standalone") onPickStandalone?.(ref, previewType);
    else onPickAttach?.(ref);
    onClose();
  }

  function pickItem(item: LinkableItem) {
    pick({ docId: item.id, kind: item.type === "canvas" ? "canvas" : "doc", title: item.title });
  }

  function pickTable(item: LinkableItem, view: { id: string; name: string } | null) {
    pick({
      docId: item.id,
      kind: "table",
      title: item.title,
      viewId: view?.id ?? null,
      ...(view ? { viewName: view.name } : {}),
      ...(item.libraryId ? { baseId: item.libraryId } : {}),
    });
  }

  // Esc 关闭由 caller 的容器处理（Popover/PopoverShell 均已自带）；这里不重复绑定。
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
            placeholder="搜索文档、画布或数据表…"
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
      ) : (
        <LinkableResultList
          items={items}
          isLoading={isLoading}
          isError={isError}
          truncated={!!data?.truncated}
          currentId={mode === "attach" && attachElement ? readElementDocRef(attachElement)?.docId ?? null : null}
          onPickItem={pickItem}
          onPickTable={pickTable}
        />
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
          onCreated={(docId, title) => pick({ docId, kind: creating, title })}
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
          onClick={() => {
            onAttachClear?.();
            onClose();
          }}
          className="w-full rounded-gx-sm border-t border-gx-separator px-2 py-1.5 text-center text-gx-12 text-gx-text-tertiary hover:bg-gx-bg hover:text-danger"
        >
          取消关联
        </button>
      )}
    </div>
  );
}
