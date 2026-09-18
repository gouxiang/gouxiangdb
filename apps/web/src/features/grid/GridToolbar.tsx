// 网格工具栏：新建 / 行高 / 字段显隐 / 筛选 / 分组 / 排序 / 行颜色 / 搜索 / 导入导出 / 批量操作。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import type { FieldDTO, TableDTO, ViewConfig, SortSpec, SortDirection } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import {
  Button,
  IconButton,
  Input,
  Popover,
  Checkbox,
  Select,
  Menu,
  MenuItem,
  MenuDivider,
  toast,
} from "../../components/ui";
import { FilterPanel } from "./FilterPanel";
import { GroupPanel } from "./GroupPanel";
import { RowColorPanel } from "./RowColorPanel";
import FieldEditorSheet from "../designer/FieldEditorSheet";
import { isSortGroupRestricted } from "../../api/records-paging";

export interface GridToolbarProps {
  config: ViewConfig;
  /** 工具栏最左侧插入的节点（视图切换器）；由宿主按 tableId/viewId 装配 */
  leading?: ReactNode;
  /**
   * 工具栏各面板（字段显隐 / 筛选 / 分组 / 排序 / 行颜色）的候选字段集。
   * 必须是「全部可列字段」而非「当前可见字段」：旧实现传可见集，导致字段一隐藏就从所有面板
   * 消失、再也选不回来（2026-09-18 真机验收发现，见 GridView.gridManageableFields）。
   */
  allFields: FieldDTO[];
  /** S8：服务端降级原因码（如 computedInMem），用于排序/分组对非物理字段逐项置灰。 */
  degradedCodes?: string[];
  filteredTotal: number;
  permissions: { canEditData: boolean; canManageSchema: boolean };
  selectionCount: number;
  onUpdateConfig: (partial: Partial<ViewConfig>) => void;
  onNewRecord: () => void;
  onBulkDelete: () => void;
  onBulkEdit: () => void;
  onClearSelection: () => void;
  onImport: () => void;
  onExport: () => void;
  onCopyView: () => void;
  onClearTable: () => void;
  onEditField: (fieldId: string | null) => void;
  /** 新建字段后是否直接显示编辑器（默认 true） */
  onFieldCreated?: (fieldId: string) => void;
  /** 字段集变更后回调（可选） */
  onFieldsChanged?: () => void;
}

function ToolButton({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex h-8 items-center gap-1.5 rounded-gx-md px-2.5 text-gx-13 transition-colors",
        active ? "bg-gx-accent-bg text-gx-accent" : "text-gx-text-secondary hover:bg-gx-bg",
      )}
    >
      <Icon name={icon} size={15} />
      <span>{label}</span>
      {badge ? (
        <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-gx-accent px-1 text-gx-11 text-white">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function GridToolbar(props: GridToolbarProps) {
  const {
    config,
    leading,
    allFields,
    degradedCodes,
    filteredTotal,
    permissions,
    selectionCount,
    onUpdateConfig,
    onNewRecord,
    onBulkDelete,
    onBulkEdit,
    onClearSelection,
    onImport,
    onExport,
    onCopyView,
    onClearTable,
    onEditField,
  } = props;

  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState(config.search);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 搜索防抖 300ms
  useEffect(() => {
    setSearch(config.search);
  }, [config.search]);

  const onSearchChange = (v: string) => {
    setSearch(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => onUpdateConfig({ search: v }), 300);
  };

  const filterActive = config.filters != null;
  const filterCount = filterActive ? countConditions(config.filters) : 0;

  // 批量操作条
  if (selectionCount > 0) {
    return (
      <div className="flex h-12 items-center gap-2 border-b border-gx-separator bg-gx-accent-bg px-3">
        <span className="text-gx-13 font-medium text-gx-accent">{selectionCount} 行已选</span>
        <div className="h-5 w-px bg-gx-border" />
        <Button size="sm" variant="secondary" onClick={onBulkEdit}>
          批量修改字段…
        </Button>
        <Button size="sm" variant="danger" icon="trash" onClick={onBulkDelete}>
          删除
        </Button>
        <Button size="sm" variant="ghost" onClick={onClearSelection}>
          取消选择
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-12 items-center gap-1 border-b border-gx-separator bg-gx-surface px-2">
      {/* 左段：视图切换器 */}
      {leading}
      {leading && <div className="h-5 w-px bg-gx-separator" />}

      <Button
        size="sm"
        variant="primary"
        icon="plus"
        disabled={!permissions.canEditData}
        onClick={onNewRecord}
        title={!permissions.canEditData ? "无编辑权限" : "新建记录"}
      >
        新建记录
      </Button>

      <div className="relative">
        <ToolButton icon="rowHeight" label="行高" onClick={() => setOpen(open === "rh" ? null : "rh")} />
        {open === "rh" && (
          <Popover open onClose={() => setOpen(null)} align="left" width={140}>
            <Menu>
              {(["short", "medium", "tall"] as const).map((h) => (
                <MenuItem
                  key={h}
                  label={h === "short" ? "紧凑" : h === "medium" ? "常规" : "宽松"}
                  active={config.rowHeight === h}
                  onClick={() => {
                    onUpdateConfig({ rowHeight: h });
                    setOpen(null);
                  }}
                />
              ))}
            </Menu>
          </Popover>
        )}
      </div>

      <div className="relative">
        <ToolButton icon="eye" label="字段" onClick={() => setOpen(open === "fields" ? null : "fields")} />
        {open === "fields" && (
          <Popover open onClose={() => setOpen(null)} align="left" width={240} className="p-2">
            {permissions.canManageSchema && (
              <button
                type="button"
                onClick={() => { setOpen(null); onEditField(null); }}
                className="mb-1 flex w-full items-center gap-1.5 rounded-gx-sm bg-gx-accent-bg px-2 py-1 text-left text-gx-13 font-medium text-gx-accent hover:brightness-95"
              >
                <Icon name="plus" size={13} />
                <span>新建字段</span>
              </button>
            )}
            <div className="mb-1 mt-1 text-gx-12 font-medium text-gx-text-secondary">显示字段</div>
            <div className="max-h-64 overflow-y-auto">
              {allFields.map((f) => (
                <label key={f.id} className="group flex items-center gap-2 rounded-gx-sm px-1 py-1 hover:bg-gx-bg">
                  <Checkbox
                    checked={!config.hiddenFieldIds.includes(f.id)}
                    onChange={() => {
                      const hidden = config.hiddenFieldIds.includes(f.id)
                        ? config.hiddenFieldIds.filter((id) => id !== f.id)
                        : [...config.hiddenFieldIds, f.id];
                      onUpdateConfig({ hiddenFieldIds: hidden });
                    }}
                  />
                  <span className="flex-1 truncate text-gx-13 text-gx-text-primary">{f.name}</span>
                  {permissions.canManageSchema && (
                    <button
                      type="button"
                      aria-label={`编辑字段 ${f.name}`}
                      title="编辑字段"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(null); onEditField(f.id); }}
                      className="rounded p-0.5 text-gx-text-hint opacity-0 hover:bg-gx-surface hover:text-gx-text-primary group-hover:opacity-100"
                    >
                      <Icon name="settings" size={12} />
                    </button>
                  )}
                </label>
              ))}
            </div>
          </Popover>
        )}
      </div>

      <div className="h-5 w-px bg-gx-separator" />

      {/* 中段 */}
      <div className="relative">
        <ToolButton
          icon="filter"
          label="筛选"
          active={filterActive}
          badge={filterActive ? filterCount : undefined}
          onClick={() => setOpen(open === "filter" ? null : "filter")}
        />
        {open === "filter" && (
          <Popover open onClose={() => setOpen(null)} align="left" width={320} className="p-0">
            <FilterPanel
              fields={allFields}
              value={config.filters}
              filteredTotal={filteredTotal}
              onChange={(next) => onUpdateConfig({ filters: next })}
            />
          </Popover>
        )}
      </div>

      <div className="relative">
        <ToolButton
          icon="group"
          label="分组"
          active={!!config.groupByFieldId}
          onClick={() => setOpen(open === "group" ? null : "group")}
        />
        {open === "group" && (
          <Popover open onClose={() => setOpen(null)} align="left" width={300} className="p-0">
            <GroupPanel
              fields={allFields}
              groupByFieldId={config.groupByFieldId}
              degradedCodes={degradedCodes}
              onChange={(id) => onUpdateConfig({ groupByFieldId: id })}
            />
          </Popover>
        )}
      </div>

      <div className="relative">
        <ToolButton
          icon="sortAsc"
          label="排序"
          active={config.sorts.length > 0}
          onClick={() => setOpen(open === "sort" ? null : "sort")}
        />
        {open === "sort" && (
          <Popover open onClose={() => setOpen(null)} align="left" width={260} className="p-2">
            <SortPanel
              fields={allFields}
              sorts={config.sorts}
              degradedCodes={degradedCodes}
              onChange={(sorts) => onUpdateConfig({ sorts })}
            />
          </Popover>
        )}
      </div>

      <div className="relative">
        <ToolButton
          icon="palette"
          label="行颜色"
          active={config.rowColor.mode !== "none"}
          onClick={() => setOpen(open === "color" ? null : "color")}
        />
        {open === "color" && (
          <Popover open onClose={() => setOpen(null)} align="left" width={320} className="p-0">
            <RowColorPanel
              fields={allFields}
              value={config.rowColor}
              onChange={(rc) => onUpdateConfig({ rowColor: rc })}
            />
          </Popover>
        )}
      </div>

      <div className="flex-1" />

      {/* 右段：搜索 */}
      <div className="relative">
        <Icon name="search" size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gx-text-hint" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索此视图…"
          className="h-8 w-48 pl-7"
        />
      </div>

      <div className="relative">
        <ToolButton icon="download" label="更多" onClick={() => setOpen(open === "more" ? null : "more")} />
        {open === "more" && (
          <Popover open onClose={() => setOpen(null)} align="right" width={180}>
            <Menu>
              <MenuItem icon="upload" label="CSV 导入" onClick={() => { onImport(); setOpen(null); }} />
              <MenuItem icon="download" label="CSV 导出" onClick={() => { onExport(); setOpen(null); }} />
              <MenuDivider />
              <MenuItem icon="copy" label="复制视图" onClick={() => { onCopyView(); setOpen(null); }} />
              <MenuItem icon="trash" label="清空表" danger onClick={() => { onClearTable(); setOpen(null); }} />
            </Menu>
          </Popover>
        )}
      </div>
    </div>
  );
}

function countConditions(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as { kind: string; children?: unknown[]; child?: unknown };
  if (n.kind === "condition") return 1;
  if (n.kind === "and" || n.kind === "or") {
    return (n.children ?? []).reduce<number>((sum, c) => sum + countConditions(c), 0);
  }
  if (n.kind === "not") return countConditions(n.child);
  return 0;
}

function SortPanel({
  fields,
  sorts,
  degradedCodes,
  onChange,
}: {
  fields: FieldDTO[];
  sorts: SortSpec[];
  degradedCodes?: string[];
  onChange: (sorts: SortSpec[]) => void;
}) {
  const toggle = (fieldId: string, dir: SortDirection) => {
    const existing = sorts.find((s) => s.fieldId === fieldId);
    let next: SortSpec[];
    if (existing && existing.direction === dir) {
      next = sorts.filter((s) => s.fieldId !== fieldId);
    } else {
      next = [...sorts.filter((s) => s.fieldId !== fieldId), { fieldId, direction: dir }];
    }
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-gx-13 font-semibold text-gx-text-primary">排序</span>
      {fields.map((f) => {
        const cur = sorts.find((s) => s.fieldId === f.id)?.direction;
        // S8：降级态下，依赖非物理字段（计算/lookup/links/长正文等）的排序会把查询逼进内存路径，禁用新切换。
        // 已生效的旧排序保持原样显示（不清、不崩），仅阻止再次切换。
        const restricted = isSortGroupRestricted(degradedCodes, f);
        const hint = "数据量较大，该字段排序需先收窄筛选";
        return (
          <div key={f.id} className="flex items-center justify-between rounded-gx-sm px-1 py-1 hover:bg-gx-bg">
            <span
              className={clsx(
                "truncate text-gx-13",
                restricted ? "text-gx-text-hint" : "text-gx-text-primary",
              )}
            >
              {f.name}
            </span>
            <div className="flex gap-1">
              <IconButton
                icon="arrowUp"
                size={14}
                active={cur === "asc"}
                label="升序"
                title={restricted ? hint : "升序"}
                aria-label={restricted ? `升序：${f.name}（${hint}）` : "升序"}
                disabled={restricted}
                className={restricted ? "disabled:cursor-not-allowed disabled:opacity-40" : undefined}
                onClick={() => toggle(f.id, "asc")}
              />
              <IconButton
                icon="arrowDown"
                size={14}
                active={cur === "desc"}
                label="降序"
                title={restricted ? hint : "降序"}
                aria-label={restricted ? `降序：${f.name}（${hint}）` : "降序"}
                disabled={restricted}
                className={restricted ? "disabled:cursor-not-allowed disabled:opacity-40" : undefined}
                onClick={() => toggle(f.id, "desc")}
              />
            </div>
          </div>
        );
      })}
      {sorts.length > 0 && (
        <Button size="sm" variant="ghost" onClick={() => onChange([])}>
          清除排序
        </Button>
      )}
    </div>
  );
}

export default GridToolbar;
