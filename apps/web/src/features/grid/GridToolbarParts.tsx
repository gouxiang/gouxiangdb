// apps/web/src/features/grid/GridToolbarParts.tsx
// 网格工具栏的共用零件：工具按钮 + 六个设置面板的构造函数。
//
// 拆出原因：GridToolbar.tsx 原本 645 行（远超「单文件 ≤300 行」）。设置项下移成独立第二行后，
// 六个面板（行高 / 字段 / 筛选 / 分组 / 排序 / 行颜色）会被**两处**消费：
//   · GridToolbarSettingsRow 的内联 Popover（宽屏常驻）
//   · GridToolbar「更多」菜单的 drill-down（窄屏收起后的等价入口）
// 功能等价红线要求两处必须是**同一份实现**，因此把构造收敛到此文件的纯函数，
// 两处各自传入自己的关闭回调（面板内改配置后要关掉自己那个浮层）。

import { clsx } from "clsx";
import type { FieldDTO, ViewConfig, SortSpec, SortDirection } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Button, Checkbox, IconButton, Menu, MenuItem } from "../../components/ui";
import { FilterPanel } from "./FilterPanel";
import { GroupPanel } from "./GroupPanel";
import { RowColorPanel } from "./RowColorPanel";
import { isSortGroupRestricted } from "../../api/records-paging";

/**
 * 工具栏按钮。
 * - `shrink-0` + `whitespace-nowrap`：窄屏不再被压到内容宽度以下，中文不会逐字断行。
 * - `className` 用于给宿主套响应式显隐（收进溢出菜单时隐藏按钮本体，功能走菜单项）。
 */
export function ToolButton({
  icon,
  label,
  active,
  badge,
  onClick,
  className,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-gx-lg px-2.5 text-gx-13 transition-colors",
        active ? "bg-gx-accent-bg text-gx-accent" : "text-gx-text-secondary hover:bg-gx-bg",
        className,
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

export function countConditions(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const n = node as { kind: string; children?: unknown[]; child?: unknown };
  if (n.kind === "condition") return 1;
  if (n.kind === "and" || n.kind === "or") {
    return (n.children ?? []).reduce<number>((sum, c) => sum + countConditions(c), 0);
  }
  if (n.kind === "not") return countConditions(n.child);
  return 0;
}

export function SortPanel({
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

export interface GridPanelArgs {
  config: ViewConfig;
  /** 候选字段集必须是「全部可列字段」而非「当前可见字段」，否则字段一隐藏就再也选不回来。 */
  allFields: FieldDTO[];
  degradedCodes?: string[];
  filteredTotal: number;
  permissions: { canEditData: boolean; canManageSchema: boolean };
  onUpdateConfig: (partial: Partial<ViewConfig>) => void;
  onEditField: (fieldId: string | null) => void;
  /** 面板内完成一次修改后关闭宿主浮层（内联 Popover 与「更多」菜单各自传自己的）。 */
  onClose: () => void;
}

/** 六个设置面板，一次构造、两处共用。返回的键名与内联/菜单两处用法一一对应。 */
export function buildGridPanels({
  config,
  allFields,
  degradedCodes,
  filteredTotal,
  permissions,
  onUpdateConfig,
  onEditField,
  onClose,
}: GridPanelArgs) {
  const rowHeightPanel = (
    <Menu>
      {(["short", "medium", "tall"] as const).map((h) => (
        <MenuItem
          key={h}
          label={h === "short" ? "紧凑" : h === "medium" ? "常规" : "宽松"}
          active={config.rowHeight === h}
          onClick={() => {
            onUpdateConfig({ rowHeight: h });
            onClose();
          }}
        />
      ))}
    </Menu>
  );

  const fieldsPanel = (
    <div className="p-2">
      {permissions.canManageSchema && (
        <button
          type="button"
          onClick={() => { onClose(); onEditField(null); }}
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
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); onEditField(f.id); }}
                className="rounded p-0.5 text-gx-text-hint opacity-0 hover:bg-gx-surface hover:text-gx-text-primary group-hover:opacity-100"
              >
                <Icon name="settings" size={12} />
              </button>
            )}
          </label>
        ))}
      </div>
    </div>
  );

  const filterPanel = (
    <FilterPanel
      fields={allFields}
      value={config.filters}
      filteredTotal={filteredTotal}
      onChange={(next) => onUpdateConfig({ filters: next })}
    />
  );

  const groupPanel = (
    <GroupPanel
      fields={allFields}
      groupByFieldId={config.groupByFieldId}
      degradedCodes={degradedCodes}
      onChange={(id) => onUpdateConfig({ groupByFieldId: id })}
    />
  );

  const sortPanel = (
    <div className="p-2">
      <SortPanel
        fields={allFields}
        sorts={config.sorts}
        degradedCodes={degradedCodes}
        onChange={(sorts) => onUpdateConfig({ sorts })}
      />
    </div>
  );

  const colorPanel = (
    <RowColorPanel
      fields={allFields}
      value={config.rowColor}
      onChange={(rc) => onUpdateConfig({ rowColor: rc })}
    />
  );

  return { rowHeightPanel, fieldsPanel, filterPanel, groupPanel, sortPanel, colorPanel };
}
