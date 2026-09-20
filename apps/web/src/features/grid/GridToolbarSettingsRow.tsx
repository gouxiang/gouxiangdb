// apps/web/src/features/grid/GridToolbarSettingsRow.tsx
// 统一外壳第三行（仅 grid 渲染）：行高 / 字段 / 筛选 / 分组 / 排序 / 行颜色——网格专属设置项。
//
// 为什么是独立一行：这六项原先和搜索框、导入导出挤在同一条工具栏里，1280 档内容区只有
// 848px 装不下（PERM-08 实测）。独立成行后宽屏六项全部常驻。
// 「新建记录」不在这里：它与搜索 / 导入 / 导出 / 更多同属外壳第二行（2026-09-21 行合并）。
//
// 为什么这一行不做 overflow-x-auto：设置项自带响应式收起（<1440 收 行高/字段/行颜色，
// <768 再收 筛选/分组/排序），实测最宽档六项总宽约 490px，任何档位都不会横向溢出；
// 而 `overflow-x-auto` 会让同一元素的 overflow-y 也变成 auto（CSS 规范：一个方向非 visible
// 时另一个方向的计算值不能再是 visible），从而把 Popover 的绝对定位浮层裁掉。
// 收起的是**入口**不是功能：被收起的按钮在本行末尾的「更多」里都有打开同一份面板的可点等价项。
//
// 注意「更多」与本文件外层的表级「更多」是**两个不同的菜单**：本行的是网格设置项的溢出
// （只在有按钮被收起时出现），外壳第二行那个是复制视图 / 清空表。

import { useState } from "react";
import type { FieldDTO, ViewConfig } from "@gx/shared-types";
import { Popover, Menu, MenuItem } from "../../components/ui";
import { Icon } from "../../components/icons";
import { FilterActiveBadge } from "../../components/interaction";
import { useBreakpointTier } from "../../lib/breakpoint";
import { ToolButton, buildGridPanels, countConditions } from "./GridToolbarParts";

export interface GridToolbarSettingsRowProps {
  config: ViewConfig;
  allFields: FieldDTO[];
  degradedCodes?: string[];
  filteredTotal: number;
  permissions: { canEditData: boolean; canManageSchema: boolean };
  onUpdateConfig: (partial: Partial<ViewConfig>) => void;
  onEditField: (fieldId: string | null) => void;
}

/** 本行「更多」的二级视图：root = 菜单本体，其余 = 被收起的按钮对应的面板。 */
type MoreView = "root" | "rh" | "fields" | "filter" | "group" | "sort" | "color";

const MORE_VIEW_TITLE: Record<Exclude<MoreView, "root">, string> = {
  rh: "行高",
  fields: "字段",
  filter: "筛选",
  group: "分组",
  sort: "排序",
  color: "行颜色",
};

export function GridToolbarSettingsRow({
  config,
  allFields,
  degradedCodes,
  filteredTotal,
  permissions,
  onUpdateConfig,
  onEditField,
}: GridToolbarSettingsRowProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [moreView, setMoreView] = useState<MoreView>("root");
  // 与外壳第二行的「更多」严格互补：<1440 这三项收进菜单，≥1440 在这一行常驻。
  // SSR / 无 window 环境回落 "2xl"，单测拿到的是桌面全部常驻的表现。
  const wideLayout = useBreakpointTier() === "2xl";

  const filterActive = config.filters != null;
  const filterCount = filterActive ? countConditions(config.filters) : 0;

  // 内联 Popover 与「更多」drill-down 共用同一份面板（GridToolbarParts.buildGridPanels），
  // 关的是自己这个浮层。
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

  const closeMore = () => {
    setOpen(null);
    setMoreView("root");
  };

  return (
    <div className="flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-gx-separator bg-gx-surface px-2 pb-1">
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

      {/* 溢出菜单：只在真有按钮被收起时出现（≥1440 六项常驻，不留多余入口） */}
      {!wideLayout && (
        <div className="relative">
          <ToolButton
            icon="moreVertical"
            label="更多"
            onClick={() => {
              setOpen(open === "more" ? null : "more");
              setMoreView("root");
            }}
          />
          {open === "more" && (
            <Popover
              open
              onClose={closeMore}
              align="right"
              width={moreView === "root" ? 180 : 288}
            >
              {moreView === "root" ? (
                <Menu width={180}>
                  <MenuItem icon="rowHeight" label="行高" onClick={() => setMoreView("rh")} />
                  <MenuItem icon="eye" label="字段" onClick={() => setMoreView("fields")} />
                  {/* <768 再收起「筛选 / 分组 / 排序」 */}
                  <div className="md:hidden">
                    <MenuItem
                      icon="filter"
                      label={filterCount > 0 ? `筛选（${filterCount}）` : "筛选"}
                      onClick={() => setMoreView("filter")}
                    />
                    <MenuItem icon="group" label="分组" onClick={() => setMoreView("group")} />
                    <MenuItem icon="sortAsc" label="排序" onClick={() => setMoreView("sort")} />
                  </div>
                  <MenuItem icon="palette" label="行颜色" onClick={() => setMoreView("color")} />
                </Menu>
              ) : (
                <div className="flex max-h-[60vh] flex-col">
                  <div className="flex shrink-0 items-center gap-1 border-b border-gx-separator px-2 py-1">
                    <button
                      type="button"
                      onClick={() => setMoreView("root")}
                      aria-label="返回设置菜单"
                      className="flex h-6 shrink-0 items-center gap-1 rounded-gx-sm px-1 text-gx-12 text-gx-text-secondary hover:bg-gx-row-hover"
                    >
                      <Icon name="chevronLeft" size={13} />
                      返回
                    </button>
                    <span className="flex-1 truncate text-right text-gx-12 font-medium text-gx-text-primary">
                      {MORE_VIEW_TITLE[moreView]}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {moreView === "rh" && rowHeightPanel}
                    {moreView === "fields" && fieldsPanel}
                    {moreView === "filter" && filterPanel}
                    {moreView === "group" && groupPanel}
                    {moreView === "sort" && sortPanel}
                    {moreView === "color" && colorPanel}
                  </div>
                </div>
              )}
            </Popover>
          )}
        </div>
      )}
    </div>
  );
}

export default GridToolbarSettingsRow;
