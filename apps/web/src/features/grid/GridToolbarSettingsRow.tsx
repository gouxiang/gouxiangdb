// apps/web/src/features/grid/GridToolbarSettingsRow.tsx
// 工具栏第二行：新建记录 / 行高 / 字段 / 筛选 / 分组 / 排序 / 行颜色。
//
// 为什么单独成行：这七个都是**视图呈现配置**，原先和搜索框、导入导出挤在同一条 48px 工具栏里，
// 1280 档内容区只有 848px 装不下（PERM-08 实测），只能靠把行高/字段/行颜色收进「更多」救场。
// 拆成第二行后它们有了独立的一整行，宽屏七项全部常驻。
//
// 为什么这一行不做 overflow-x-auto：设置项自带响应式收起（<1440 收 行高/字段/行颜色，
// <768 再收 筛选/分组/排序），实测最宽档七项总宽约 490px，任何档位都不会横向溢出；
// 而 `overflow-x-auto` 会让同一元素的 overflow-y 也变成 auto（CSS 规范：
// 一个方向非 visible 时另一个方向的计算值不能再是 visible），从而把 Popover 的绝对定位
// 浮层裁掉。因此这一行走「按断点收进「更多」菜单」，不走横向滚动。

import { useState } from "react";
import type { FieldDTO, ViewConfig } from "@gx/shared-types";
import { Button, Popover } from "../../components/ui";
import { FilterActiveBadge } from "../../components/interaction";
import { useBreakpointTier } from "../../lib/breakpoint";
import { ToolButton, buildGridPanels, countConditions } from "./GridToolbarParts";

export interface GridToolbarSettingsRowProps {
  config: ViewConfig;
  allFields: FieldDTO[];
  degradedCodes?: string[];
  filteredTotal: number;
  permissions: { canEditData: boolean; canManageSchema: boolean };
  /** R-I-26 新建记录在途（按钮立即禁用 + spinner，防双击产生两条） */
  newRecordBusy?: boolean;
  onUpdateConfig: (partial: Partial<ViewConfig>) => void;
  onNewRecord: () => void;
  onEditField: (fieldId: string | null) => void;
}

export function GridToolbarSettingsRow({
  config,
  allFields,
  degradedCodes,
  filteredTotal,
  permissions,
  newRecordBusy,
  onUpdateConfig,
  onNewRecord,
  onEditField,
}: GridToolbarSettingsRowProps) {
  const [open, setOpen] = useState<string | null>(null);
  // 与 GridToolbar「更多」菜单严格互补：<1440 这三项收进菜单，≥1440 在这一行常驻。
  // SSR / 无 window 环境回落 "2xl"，单测拿到的是桌面全部常驻的表现。
  const wideLayout = useBreakpointTier() === "2xl";

  const filterActive = config.filters != null;
  const filterCount = filterActive ? countConditions(config.filters) : 0;

  // PERM-A2 粘滞 tooltip 根因：提示是**原生 title**，而浏览器不对 disabled 表单控件派发
  // 任何鼠标事件 → 按钮进入 disabled 后 mouseleave 永不到达，tooltip 冻结在屏幕上。
  // 修法：锁定期把 title 交给外层**永不 disabled** 的 span，并给按钮 pointer-events-none
  // 让 hover 命中穿透到 span。按钮自身的 disabled 口径与两段文案一字未动。
  const newRecordTitle = !permissions.canEditData ? "无编辑权限" : "新建记录";
  const newRecordLocked = !permissions.canEditData || !!newRecordBusy;

  // 与「更多」菜单的 drill-down 严格同一份面板（GridToolbarParts.buildGridPanels），
  // 关的是自己这个内联 Popover。
  const { rowHeightPanel, fieldsPanel, filterPanel, groupPanel, sortPanel, colorPanel } =
    buildGridPanels({
      config,
      allFields,
      degradedCodes,
      filteredTotal,
      permissions,
      onUpdateConfig,
      onEditField,
      onClose: () => setOpen(null),
    });

  return (
    <div className="flex h-10 min-w-0 items-center gap-1 px-2 pb-1">
      <span className="inline-flex shrink-0" title={newRecordLocked ? newRecordTitle : undefined}>
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          disabled={!permissions.canEditData}
          loading={newRecordBusy}
          onClick={onNewRecord}
          title={newRecordLocked ? undefined : newRecordTitle}
          className={newRecordLocked ? "pointer-events-none" : undefined}
        >
          新建记录
        </Button>
      </span>

      {/* 行高 / 字段：<1440 收进「更多」菜单（见文件头注释） */}
      {wideLayout && (
        <div className="relative hidden lg:block">
          <ToolButton icon="rowHeight" label="行高" onClick={() => setOpen(open === "rh" ? null : "rh")} />
          {open === "rh" && (
            <Popover open onClose={() => setOpen(null)} align="left" width={140}>
              {rowHeightPanel}
            </Popover>
          )}
        </div>
      )}

      {wideLayout && (
        <div className="relative hidden lg:block">
          <ToolButton icon="eye" label="字段" onClick={() => setOpen(open === "fields" ? null : "fields")} />
          {open === "fields" && (
            <Popover open onClose={() => setOpen(null)} align="left" width={240}>
              {fieldsPanel}
            </Popover>
          )}
        </div>
      )}

      {wideLayout && <div className="h-5 w-px hidden shrink-0 bg-gx-separator lg:block" />}

      {/* <768 收进「更多」菜单（768–1023 仍常驻） */}
      <div className="relative hidden md:block">
        <ToolButton
          icon="filter"
          label="筛选"
          active={filterActive}
          badge={filterActive ? filterCount : undefined}
          onClick={() => setOpen(open === "filter" ? null : "filter")}
        />
        {open === "filter" && (
          <Popover open onClose={() => setOpen(null)} align="left" width={320} className="p-0">
            {filterPanel}
          </Popover>
        )}
      </div>

      {/* R-I-04：筛选生效后跟在「筛选」后显示「筛选中」徽标，可一键清空 */}
      {filterActive && (
        <FilterActiveBadge
          count={filterCount || undefined}
          onClear={() => onUpdateConfig({ filters: null })}
        />
      )}

      <div className="relative hidden md:block">
        <ToolButton
          icon="group"
          label="分组"
          active={!!config.groupByFieldId}
          onClick={() => setOpen(open === "group" ? null : "group")}
        />
        {open === "group" && (
          <Popover open onClose={() => setOpen(null)} align="left" width={300} className="p-0">
            {groupPanel}
          </Popover>
        )}
      </div>

      <div className="relative hidden md:block">
        <ToolButton
          icon="sortAsc"
          label="排序"
          active={config.sorts.length > 0}
          onClick={() => setOpen(open === "sort" ? null : "sort")}
        />
        {open === "sort" && (
          <Popover open onClose={() => setOpen(null)} align="left" width={260}>
            {sortPanel}
          </Popover>
        )}
      </div>

      {/* 行颜色：<1440 收进「更多」菜单（同 行高 / 字段） */}
      {wideLayout && (
        <div className="relative hidden lg:block">
          <ToolButton
            icon="palette"
            label="行颜色"
            active={config.rowColor.mode !== "none"}
            onClick={() => setOpen(open === "color" ? null : "color")}
          />
          {open === "color" && (
            <Popover open onClose={() => setOpen(null)} align="left" width={320} className="p-0">
              {colorPanel}
            </Popover>
          )}
        </div>
      )}
    </div>
  );
}

export default GridToolbarSettingsRow;
