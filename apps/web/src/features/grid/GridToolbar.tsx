// 网格工具栏：新建 / 行高 / 字段显隐 / 筛选 / 分组 / 排序 / 行颜色 / 搜索 / 导入导出 / 批量操作。
//
// 窄屏（R-D-31/R-D-32/R-D-33）口径：按钮**不删功能、只收入口**。
//   <1024：行高 / 字段 / 行颜色 收进右端「更多」溢出菜单（drill-down 打开同一份面板）
//   <768 ：筛选 / 分组 / 排序 也收进同一个溢出菜单，搜索框改为自适应宽度
//   ≥1024：与改动前完全一致（全部按钮常驻、文案不变）
// 收起的每一个按钮在溢出菜单里都有可点的等价项（功能优先，禁止为布局删按钮）。
// 断行根因：ToolButton 原来既没有 shrink-0 也没有 whitespace-nowrap，窄屏下 flex 子项被压到
// 小于内容宽度，中文按字断行 → 每个字一行。现在 nowrap + shrink-0 保证任何档位都单行。

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
// 阶段 4：批量条（R-I-12/13/14）、搜索框 170×32 与防抖 300ms（R-I-03）、「筛选中」徽标（R-I-04）
import {
  BulkActionBar,
  FilterActiveBadge,
  ListSearchBox,
  bulkDeleteText,
  useDebouncedCommit,
} from "../../components/interaction";

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

/**
 * 工具栏按钮。
 * - `shrink-0` + `whitespace-nowrap`：窄屏不再被压到内容宽度以下，中文不会逐字断行。
 * - `className` 用于给宿主套响应式显隐（收进溢出菜单时隐藏按钮本体，功能走菜单项）。
 */
function ToolButton({
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

  const [open, setOpen] = useState<string | null>(null);
  /** 溢出菜单的二级视图（窄屏 drill-down） */
  const [moreView, setMoreView] = useState<MoreView>("root");
  // R-I-03：搜索输入防抖 300ms（此前是各列表各写一份 setTimeout，口径统一到 hook）
  const search = useDebouncedCommit(config.search, (v) => onUpdateConfig({ search: v }));

  const filterActive = config.filters != null;
  const filterCount = filterActive ? countConditions(config.filters) : 0;

  const closeAll = () => {
    setOpen(null);
    setMoreView("root");
  };

  // —— 面板内容：内联按钮与溢出菜单共用一份，改一处即同步，避免功能漂移 ——
  const rowHeightPanel = (
    <Menu>
      {(["short", "medium", "tall"] as const).map((h) => (
        <MenuItem
          key={h}
          label={h === "short" ? "紧凑" : h === "medium" ? "常规" : "宽松"}
          active={config.rowHeight === h}
          onClick={() => {
            onUpdateConfig({ rowHeight: h });
            closeAll();
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
          onClick={() => { closeAll(); onEditField(null); }}
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
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); closeAll(); onEditField(f.id); }}
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

  // R-I-12 批量条：勾选后**替换**原工具栏，显示「已选 N 条」+ 操作 + 取消选择
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
    <div className="flex h-12 items-center gap-1 border-b border-gx-separator bg-gx-surface px-2">
      {/* 左段：视图切换器 */}
      {leading}
      {leading && <div className="h-5 w-px shrink-0 bg-gx-separator" />}

      <Button
        size="sm"
        variant="primary"
        icon="plus"
        disabled={!permissions.canEditData}
        loading={newRecordBusy}
        onClick={onNewRecord}
        title={!permissions.canEditData ? "无编辑权限" : "新建记录"}
      >
        新建记录
      </Button>

      {/* R-I-04：筛选生效后在工具栏显示「筛选中」徽标，可一键清空 */}
      {filterActive && (
        <FilterActiveBadge
          count={filterCount || undefined}
          onClear={() => onUpdateConfig({ filters: null })}
        />
      )}

      {/* 行高：<1024 收进溢出菜单（菜单项「行高」打开同一面板） */}
      <div className="relative hidden lg:block">
        <ToolButton icon="rowHeight" label="行高" onClick={() => setOpen(open === "rh" ? null : "rh")} />
        {open === "rh" && (
          <Popover open onClose={() => setOpen(null)} align="left" width={140}>
            {rowHeightPanel}
          </Popover>
        )}
      </div>

      {/* 字段：<1024 收进溢出菜单 */}
      <div className="relative hidden lg:block">
        <ToolButton icon="eye" label="字段" onClick={() => setOpen(open === "fields" ? null : "fields")} />
        {open === "fields" && (
          <Popover open onClose={() => setOpen(null)} align="left" width={240}>
            {fieldsPanel}
          </Popover>
        )}
      </div>

      <div className="h-5 w-px hidden shrink-0 bg-gx-separator lg:block" />

      {/* 中段：<768 收进溢出菜单（768–1023 仍常驻，参考图主操作） */}
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

      {/* 行颜色：<1024 收进溢出菜单 */}
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
          藏在「更多」里等于让新用户找不到；窄屏同样不收起（ToolButton 自带 shrink-0，
          <768 被压缩的是搜索框那个 flex-1 容器，按钮本身不换行、不会挤掉其它按钮）。 */}
      <ToolButton icon="upload" label="导入" onClick={onImport} />
      <ToolButton icon="download" label="导出" onClick={onExport} />

      {/* 溢出菜单：桌面装复制视图 / 清空表等表级操作；窄屏额外装载被收起的按钮（功能一一等价）。
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
                {/* R-D-31/32：<1024 收起「行高 / 字段 / 行颜色」——入口收起，功能保留 */}
                <div className="lg:hidden">
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
                {/* 导入 / 导出已从菜单摘掉：提升为工具栏常驻按钮（见上方 ToolButton），
                    避免同一能力两个入口。菜单里不再留重复项。 */}
                <MenuItem icon="copy" label="复制视图" onClick={() => { onCopyView(); closeAll(); }} />
                <MenuItem icon="trash" label="清空表" danger onClick={() => { onClearTable(); closeAll(); }} />
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
