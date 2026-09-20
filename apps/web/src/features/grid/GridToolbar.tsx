// apps/web/src/features/grid/GridToolbar.tsx
// 网格工具栏：第一行承载视图切换器（宿主传入）/ 搜索 / 导入 / 导出 / 更多（表级操作）；
// 第二行（GridToolbarSettingsRow）承载七个视图呈现配置项。
//
// 两行的职责切分见 GridToolbarSettingsRow 文件头注释：原先七项设置与搜索、导入导出同处一行，
// 1280 档撑不下只能大量收进「更多」；下移成独立一行后宽屏七项全部常驻。
//
// 其余口径不变：
//   ① 导入 / 导出是常驻按钮（第四批入口收敛后全站唯一入口），落在搜索框右侧
//   ② 「更多」菜单只在窄屏额外装载被收起的设置项——**收的是入口不是功能**，
//      每个被收起的按钮在菜单里都有打开同一份面板的可点等价项
//   ③ 批量选择条替换整个工具栏（R-I-12）

import { useState, type ReactNode } from "react";
import type { FieldDTO, ViewConfig } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Button, Popover, Menu, MenuItem, MenuDivider } from "../../components/ui";
import { useBreakpointTier } from "../../lib/breakpoint";
import {
  BulkActionBar,
  ListSearchBox,
  bulkDeleteText,
  useDebouncedCommit,
} from "../../components/interaction";
import { ToolButton, buildGridPanels, countConditions } from "./GridToolbarParts";
import GridToolbarSettingsRow from "./GridToolbarSettingsRow";

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
  /** R-I-26 新建记录在途（按钮立即禁用 + spinner，防双击产生两条） */
  newRecordBusy?: boolean;
  onUpdateConfig: (partial: Partial<ViewConfig>) => void;
  onNewRecord: () => void;
  onBulkDelete: () => void;
  onBulkEdit: () => void;
  onSelectAllPage: () => void;
  onClearSelection: () => void;
  onImport: () => void;
  onExport: () => void;
  onCopyView: () => void;
  onClearTable: () => void;
  onEditField: (fieldId: string | null) => void;
}

/**
 * 溢出菜单（⋮）的二级视图：root = 菜单本体，其余 = 被收起的按钮对应的面板。
 * 与内联按钮共用同一份面板组件（同一 state、同一回调），因此功能严格等价。
 */
type MoreView = "root" | "rh" | "fields" | "filter" | "group" | "sort" | "color";

const MORE_VIEW_TITLE: Record<Exclude<MoreView, "root">, string> = {
  rh: "行高",
  fields: "字段",
  filter: "筛选",
  group: "分组",
  sort: "排序",
  color: "行颜色",
};

export function GridToolbar(props: GridToolbarProps) {
  const {
    config,
    leading,
    allFields,
    degradedCodes,
    filteredTotal,
    permissions,
    selectionCount,
    newRecordBusy,
    onUpdateConfig,
    onNewRecord,
    onBulkDelete,
    onBulkEdit,
    onSelectAllPage,
    onClearSelection,
    onImport,
    onExport,
    onCopyView,
    onClearTable,
    onEditField,
  } = props;

  /** 第二行内联按钮的浮层由第二行自己管；这里是「更多」菜单的状态 */
  const [open, setOpen] = useState<string | null>(null);
  const [moreView, setMoreView] = useState<MoreView>("root");
  // R-I-03：搜索输入防抖 300ms（此前是各列表各写一份 setTimeout，口径统一到 hook）
  const search = useDebouncedCommit(config.search, (v) => onUpdateConfig({ search: v }));

  const filterActive = config.filters != null;
  const filterCount = filterActive ? countConditions(config.filters) : 0;

  // PERM-08（工具栏 1280~1440 溢出）：<1440 时第二行的「行高 / 字段 / 行颜色」收进「更多」，
  // ≥1440 与改动前逐字一致。这里必须与 GridToolbarSettingsRow 的 wideLayout 严格互补，
  // 保证任何档位下这三项都恰好出现一次。SSR 回落 "2xl"，单测拿到的是桌面表现。
  const wideLayout = useBreakpointTier() === "2xl";

  const closeAll = () => {
    setOpen(null);
    setMoreView("root");
  };

  const { rowHeightPanel, fieldsPanel, filterPanel, groupPanel, sortPanel, colorPanel } =
    buildGridPanels({
      config,
      allFields,
      degradedCodes,
      filteredTotal,
      permissions,
      onUpdateConfig,
      onEditField,
      onClose: closeAll,
    });

  // R-I-12 批量条：勾选后**替换**整个工具栏（两行一起），显示「已选 N 条」+ 操作 + 取消选择
  if (selectionCount > 0) {
    return (
      <BulkActionBar
        count={selectionCount}
        total={filteredTotal}
        onSelectAll={onSelectAllPage}
        onClearSelection={onClearSelection}
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={onBulkEdit}>
              批量修改字段…
            </Button>
            {/* R-I-14：批量操作前展示影响条数——按钮文案直接带条数 */}
            <Button size="sm" variant="danger" icon="trash" onClick={onBulkDelete}>
              {bulkDeleteText(selectionCount, "行")}
            </Button>
          </>
        }
      />
    );
  }

  return (
    <div className="shrink-0 border-b border-gx-separator bg-gx-surface">
      {/* 第一行：视图切换器 / 搜索 / 导入 / 导出 / 更多 */}
      <div className="flex h-12 items-center gap-1 px-2">
        {leading}
        {leading && <div className="h-5 w-px shrink-0 bg-gx-separator" />}

        {/* 右段：搜索（R-I-03 宽 170 / 高 32 / 防抖 300ms / 搜索中置灰保留旧结果）
            <768 主轴撑满（不换行、不挤掉其它按钮），≥768 严格回到 170 定宽 */}
        <div className="ml-auto flex min-w-0 flex-1 md:flex-none">
          <ListSearchBox
            value={search.value}
            onChange={search.setValue}
            placeholder="搜索此视图…"
            searching={search.pending}
            width={null}
            className="w-full md:w-[170px]"
          />
        </div>

        {/* 导入 / 导出：第四批入口收敛后由这里独家承载（L2 表级操作行的导入导出格已下线）。
            位置在搜索框**右侧**、常驻可见——表级导入导出是全站唯一的写入/导出口，
            藏在「更多」里等于让新用户找不到；窄屏同样不收起（ToolButton 自带 shrink-0）。 */}
        {/* 权限口径（WALK-权限组合-2026-09-20 · PERM-A1）：导入是**写数据**入口，无权限**不渲染**，
            不做成灰色可点、也不让用户填完向导再被后端 403 打回。
            权限源沿用本工具栏既有的一份（permissions.canEditData，来自 base.permissions）。
            导出是读派生，不受此门控，仍对所有可见该表的身份常驻。 */}
        {permissions.canEditData && (
          <ToolButton icon="upload" label="导入" onClick={onImport} />
        )}
        <ToolButton icon="download" label="导出" onClick={onExport} />

        {/* 溢出菜单：桌面装复制视图 / 清空表等表级操作；窄屏额外装载被收起的设置项。
            导入 / 导出已改为常驻按钮，不再出现在菜单里。 */}
        <div className="relative">
          <ToolButton
            icon="download"
            label="更多"
            onClick={() => {
              setOpen(open === "more" ? null : "more");
              setMoreView("root");
            }}
          />
          {open === "more" && (
            <Popover
              open
              onClose={closeAll}
              align="right"
              width={moreView === "root" ? 180 : 288}
            >
              {moreView === "root" ? (
                <Menu width={180}>
                  {/* R-D-31/32 + PERM-08：<1440 收起「行高 / 字段 / 行颜色」——入口收起，功能保留 */}
                  {!wideLayout && (
                    <div>
                      <MenuItem icon="rowHeight" label="行高" onClick={() => setMoreView("rh")} />
                      <MenuItem icon="eye" label="字段" onClick={() => setMoreView("fields")} />
                      {/* R-D-33：<768 再收起「筛选 / 分组 / 排序」 */}
                      <div className="md:hidden">
                        <MenuItem
                          icon="filter"
                          active={filterActive}
                          label={filterCount > 0 ? `筛选（${filterCount}）` : "筛选"}
                          onClick={() => setMoreView("filter")}
                        />
                        <MenuItem
                          icon="group"
                          active={!!config.groupByFieldId}
                          label="分组"
                          onClick={() => setMoreView("group")}
                        />
                        <MenuItem
                          icon="sortAsc"
                          active={config.sorts.length > 0}
                          label="排序"
                          onClick={() => setMoreView("sort")}
                        />
                      </div>
                      <MenuItem
                        icon="palette"
                        active={config.rowColor.mode !== "none"}
                        label="行颜色"
                        onClick={() => setMoreView("color")}
                      />
                      <MenuDivider />
                    </div>
                  )}
                  <MenuItem icon="copy" label="复制视图" onClick={() => { onCopyView(); closeAll(); }} />
                  {/* 权限口径（WALK-权限组合-2026-09-20 · PERM-02）：破坏性入口无权限时**不渲染**。
                      后端真值：`POST /tables/:tableId/clear`（apps/api/src/routes/tables.ts:441）
                      只要求 requireCanEditData，因此这里的门与后端完全一致，既不松也不紧。 */}
                  {permissions.canEditData && (
                    <MenuItem icon="trash" label="清空表" danger onClick={() => { onClearTable(); closeAll(); }} />
                  )}
                </Menu>
              ) : (
                <div className="flex max-h-[60vh] flex-col">
                  <div className="flex shrink-0 items-center gap-1 border-b border-gx-separator px-2 py-1">
                    <button
                      type="button"
                      onClick={() => setMoreView("root")}
                      aria-label="返回更多菜单"
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
      </div>

      {/* 第二行：七个视图呈现配置项（GridToolbarSettingsRow） */}
      <GridToolbarSettingsRow
        config={config}
        allFields={allFields}
        degradedCodes={degradedCodes}
        filteredTotal={filteredTotal}
        permissions={permissions}
        newRecordBusy={newRecordBusy}
        onUpdateConfig={onUpdateConfig}
        onNewRecord={onNewRecord}
        onEditField={onEditField}
      />
    </div>
  );
}

export default GridToolbar;
