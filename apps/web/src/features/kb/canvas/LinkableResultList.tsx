// apps/web/src/features/kb/canvas/LinkableResultList.tsx
// 关联选择器的结果列表（纯展示 + 数据表「选视图」二级展开）。
//
// 数据源是 GET /api/linkable 的 items（后端已按库权限过滤，前端不再做任何可见性判断）。
// 一条结果展示：类型图标 + 标题 + 所属库名 + path 面包屑；truncated 时给「还有更多」提示。
//
// 数据表多一级：一张表可能有网格/看板/画廊/日历多个视图，点表先展开该表的视图清单，
// 选定视图后才回调（viewId=null 表示用该表默认视图）。

import { useState } from "react";
import { Icon, VIEW_ICON } from "../../../components/icons";
import { Spinner } from "../../../components/ui";
import { DocKindIcon } from "../kb-ui";
import { useTableViews } from "./linkable-hooks";
import type { LinkableItem } from "../../../api/client";

export interface PickedView {
  id: string;
  name: string;
}

export interface LinkableResultListProps {
  items: LinkableItem[];
  isLoading: boolean;
  isError: boolean;
  /** 后端截断标记：还有更多结果未返回（提示用户搜索收窄） */
  truncated: boolean;
  /** attach 模式：已关联的目标 id（该行高亮 + 对勾） */
  currentId?: string | null;
  /** 选中文档 / 画布 */
  onPickItem: (item: LinkableItem) => void;
  /** 选中数据表（view=null 表示用该表默认视图） */
  onPickTable: (item: LinkableItem, view: PickedView | null) => void;
}

/** 文档/画布行的类型：LinkableItem.type 里可作关联目标的三类。 */
type PickableKind = "doc" | "canvas" | "table";

function asPickable(kind: LinkableItem["type"]): PickableKind {
  return kind === "canvas" ? "canvas" : kind === "table" ? "table" : "doc";
}

/** 库名 / 面包屑副标题：库名 + 父级路径（path 为空则不显示面包屑）。 */
function Subtitle({ item }: { item: LinkableItem }) {
  const crumbs = item.path ?? [];
  if (!item.libraryName && crumbs.length === 0) return null;
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1 text-gx-11 text-gx-text-hint">
      {item.libraryName && <span className="shrink-0 truncate">{item.libraryName}</span>}
      {item.libraryName && crumbs.length > 0 && <Icon name="chevronRight" size={9} className="shrink-0" />}
      {crumbs.length > 0 && <span className="min-w-0 truncate">{crumbs.join(" / ")}</span>}
    </span>
  );
}

/** 数据表展开后的视图清单（懒加载，只在展开时请求）。 */
function TableViewOptions({
  item,
  onPick,
  onBack,
}: {
  item: LinkableItem;
  onPick: (view: PickedView | null) => void;
  onBack: () => void;
}) {
  const { data: views, isLoading, isError } = useTableViews(item.id);

  return (
    <div className="border-l-2 border-gx-accent-bg bg-gx-bg px-2 py-1">
      <button
        type="button"
        onClick={onBack}
        className="mb-1 flex w-full items-center gap-1 py-0.5 text-left text-gx-11 text-gx-text-tertiary hover:text-gx-text-secondary"
      >
        <Icon name="chevronLeft" size={11} />
        返回对象列表
      </button>
      {/* 默认视图兜底入口恒在：视图拉取失败 / 该表没有视图时仍可选 */}
      <button
        type="button"
        onClick={() => onPick(null)}
        className="flex w-full items-center gap-2 rounded-gx-sm px-1.5 py-1 text-left hover:bg-gx-surface"
      >
        <Icon name="grid" size={13} className="text-gx-text-hint" />
        <span className="text-gx-12 text-gx-text-secondary">使用默认视图</span>
      </button>
      {isLoading && (
        <div className="flex justify-start px-1.5 py-1">
          <Spinner size={14} />
        </div>
      )}
      {(isError || (views && views.length === 0)) && (
        <div className="px-1.5 py-1 text-gx-11 text-gx-text-hint">
          {isError ? "视图加载失败，可用默认视图插入。" : "该表暂无视图，插入后将使用默认视图。"}
        </div>
      )}
      {views?.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => onPick({ id: v.id, name: v.name })}
          className="flex w-full items-center gap-2 rounded-gx-sm px-1.5 py-1 text-left hover:bg-gx-surface"
        >
          <Icon name={VIEW_ICON[v.type] ?? "grid"} size={13} className="text-gx-text-tertiary" />
          <span className="min-w-0 flex-1 truncate text-gx-12 text-gx-text-primary">{v.name}</span>
          <Icon name="plus" size={12} className="text-gx-text-hint" />
        </button>
      ))}
    </div>
  );
}

export function LinkableResultList({
  items,
  isLoading,
  isError,
  truncated,
  currentId,
  onPickItem,
  onPickTable,
}: LinkableResultListProps) {
  const [expandedTableId, setExpandedTableId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center px-3 py-6">
        <Spinner size={16} />
      </div>
    );
  }
  if (isError) {
    return <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">加载失败，请稍后重试。</div>;
  }
  if (items.length === 0) {
    return <div className="px-3 py-6 text-center text-gx-12 text-gx-text-hint">无匹配结果</div>;
  }

  return (
    <div className="max-h-64 overflow-y-auto py-1">
      {items.map((item) => {
        const kind = asPickable(item.type);
        const isCurrent = !!currentId && currentId === item.id;
        if (kind === "table" && expandedTableId === item.id) {
          return (
            <TableViewOptions
              key={item.id}
              item={item}
              onBack={() => setExpandedTableId(null)}
              onPick={(view) => onPickTable(item, view)}
            />
          );
        }
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => (kind === "table" ? setExpandedTableId(item.id) : onPickItem(item))}
            className={`flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-gx-accent-bg ${
              isCurrent ? "text-gx-accent" : "text-gx-text-primary"
            }`}
          >
            <span className="mt-0.5 shrink-0">
              <DocKindIcon kind={kind} size={14} icon={item.icon} iconColor={item.iconColor} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-gx-13">{item.title || "未命名"}</span>
              <Subtitle item={item} />
            </span>
            {isCurrent ? (
              <Icon name="check" size={13} className="mt-0.5 shrink-0" />
            ) : (
              <Icon
                name={kind === "table" ? "chevronRight" : "plus"}
                size={13}
                className="mt-0.5 shrink-0 text-gx-text-hint"
              />
            )}
          </button>
        );
      })}
      {truncated && (
        <div className="px-2.5 pb-1 pt-2 text-gx-11 text-gx-text-hint">
          结果已截断，还有更多未显示——试试输入关键词缩小范围。
        </div>
      )}
    </div>
  );
}
