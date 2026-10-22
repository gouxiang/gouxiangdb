// apps/web/src/features/grid/GridToolbar.tsx
// 统一视图工具栏：由 features/views/ViewShell 为**六类视图**装配，不再是网格的私有子树。
//   第一行 = 视图标签条（宿主经 leading 传入：数据表图标入口 + ViewSwitcher），独占整行；
//   第二行 = 新建记录（左端） + 搜索 / 导入 / 导出 / 更多（右端，ml-auto）。
//
// 为什么上提：2026-09-21 产品走查发现切到 kanban / calendar / gallery / form / detail 后，
// 标签条与工具栏整体消失（它们原先长在 GridView 里），五种视图像是"不在整体框架内"。
// 现在这两行由外壳统一装配，六类视图口径一致；本文件只剩与视图类型无关的两行。
//
// 网格专属的第三行（行高 / 字段 / 筛选 / 分组 / 排序 / 行颜色）不在这里，由 GridView 自己渲染：
// 那六项是网格行列概念，数据来自网格的无限滚动查询（filteredTotal / degradedCodes）与网格内
// 的字段编辑器，上提会让外壳为每种视图多拉一份列表查询。详见 ViewShell.tsx 文件头。
//
// 口径不变的三条：
//   ① 导入 / 导出是常驻按钮（全站唯一入口），落在搜索框右侧
//   ② 「更多」只装表级操作（复制视图 / 清空表）；被收起的网格设置项归第三行自己的溢出菜单
//   ③ 新建记录：无编辑权限时 disabled + 原因（数据编辑类保留 disabled，不做隐藏）

import { useState, type ReactNode } from "react";
import type { ViewConfig } from "@gx/shared-types";
import { Button, Menu, MenuItem, Popover } from "../../components/ui";
import { ListSearchBox, useDebouncedCommit } from "../../components/interaction";
import { ToolButton } from "./GridToolbarParts";

export interface GridToolbarProps {
  config: ViewConfig;
  /** 第一行：视图标签条，由 ViewShell 装配（六类视图都有） */
  leading?: ReactNode;
  permissions: { canEditData: boolean; canManageSchema: boolean };
  /** R-I-26 新建记录在途（按钮立即禁用 + spinner，防双击产生两条） */
  newRecordBusy?: boolean;
  onUpdateConfig: (partial: Partial<ViewConfig>) => void;
  onNewRecord: () => void;
  onImport: () => void;
  onExport: () => void;
  onCopyView: () => void;
  onClearTable: () => void;
  /**
   * 分享：打开数据表分享弹窗（外壳持有弹窗，六类视图共用同一份）。
   * 可选——老调用点（单测里的裸工具栏）不传就不渲染这一项。
   */
  onShare?: () => void;
}

export function GridToolbar({
  config,
  leading,
  permissions,
  newRecordBusy,
  onUpdateConfig,
  onNewRecord,
  onImport,
  onExport,
  onCopyView,
  onClearTable,
  onShare,
}: GridToolbarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  // R-I-03：搜索输入防抖 300ms（此前是各列表各写一份 setTimeout，口径统一到 hook）
  const search = useDebouncedCommit(config.search, (v) => onUpdateConfig({ search: v }));
  const closeMore = () => setMoreOpen(false);

  // PERM-A2 / R-D-09：无编辑权限时按钮 disabled，原因挂在**外层永不 disabled 的 span** 上
  // （浏览器不对 disabled 控件派发鼠标事件，title 挂在按钮上会冻结在屏幕上）。
  // 注意这里**不再给按钮加 pointer-events-none**：它会把「有权限、仅在途」的点击一起吞掉——
  // 2026-09-21 实测「新建记录点了没反应」就是这么来的。busy 期间由 Button 的 loading
  // 语义自行禁用（ui.tsx：isDisabled = !!disabled || !!loading），不需要再叠一层透明挡板。
  const newRecordTitle = !permissions.canEditData ? "无编辑权限" : "新建记录";

  return (
    // v6 #984：底线由三行各自挂（vbar/tbar/sbar 均 border-b line-2），根不再整条压底避免双线。
    <div className="shrink-0 bg-gx-surface">
      {/* 第一行：视图标签条独占整行（底板 .vbar：min-h40 / px10 / py6 / gap2 / 底线 line-2） */}
      {leading ? (
        <div
          data-gx-toolbar-view-row=""
          className="flex min-h-[40px] min-w-0 items-center gap-0.5 border-b border-gx-separator px-2.5 py-1.5"
        >
          {leading}
        </div>
      ) : null}

      {/* 第二行（底板 .tbar：py8/px10/gap6/底线 line-2）：新建记录（左） + 搜索 / 导入 / 导出 / 更多（右） */}
      <div className="flex min-w-0 items-center gap-1.5 border-b border-gx-separator px-2.5 py-2">
        <span className="inline-flex shrink-0" title={newRecordTitle}>
          <Button
            size="sm"
            variant="primary"
            icon="plus"
            disabled={!permissions.canEditData}
            loading={newRecordBusy}
            onClick={onNewRecord}
            className="h-[26px] px-[9px] text-gx-12"
          >
            新建记录
          </Button>
        </span>

        {/* 右端组：ml-auto 顶到最右；<768 搜索框随主轴伸缩，≥768 严格回到 170（R-I-03） */}
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 md:flex-none">
          <ListSearchBox
            value={search.value}
            onChange={search.setValue}
            placeholder="搜索此视图…"
            searching={search.pending}
            width={null}
            className="w-full md:w-[170px]"
          />
        </div>

        {/* 导入 / 导出：入口收敛后由这里独家承载，常驻不收起 */}
        {/* 权限口径（WALK-权限组合-2026-09-20 · PERM-A1）：导入是**写数据**入口，无权限**不渲染**，
            不做成灰色可点、也不让用户填完向导再被后端 403 打回。
            导出是读派生，不受此门控，仍对所有可见该表的身份常驻。 */}
        {permissions.canEditData && (
          <ToolButton icon="upload" label="导入" onClick={onImport} />
        )}
        <ToolButton icon="download" label="导出" onClick={onExport} />

        {/* 「视图设置」入口已从此处移走：现放在视图标签右侧「⋯」菜单里（重命名旁边），
            见 ViewSwitcher —— 工具栏上的独立按钮位置反直觉。 */}

        {/* 溢出菜单：表级操作（复制视图 / 清空表）。被收起的网格设置项不在这里——
            它们归第三行的溢出菜单，六类视图里只有网格有第三行。 */}
        <div className="relative">
          <ToolButton icon="moreVertical" label="更多" onClick={() => setMoreOpen((v) => !v)} />
          {moreOpen && (
            <Popover open onClose={closeMore} align="right" width={180}>
              <Menu width={180}>
                {/* 分享放在表级操作首位：它是本表唯一的外发入口（旧的「分享数据」规划占位已下线）。
                    读派生，不做权限门控——没开分享时后端 403 的原文会由弹窗直接说明原因。 */}
                {onShare ? (
                  <MenuItem icon="share" label="分享" onClick={() => { onShare(); closeMore(); }} />
                ) : null}
                <MenuItem icon="copy" label="复制视图" onClick={() => { onCopyView(); closeMore(); }} />
                {/* 权限口径（WALK-权限组合-2026-09-20 · PERM-02）：破坏性入口无权限时**不渲染**。
                    后端真值：`POST /tables/:tableId/clear`（apps/api/src/routes/tables.ts:441）
                    只要求 requireCanEditData，因此这里的门与后端完全一致，既不松也不紧。 */}
                {permissions.canEditData && (
                  <MenuItem icon="trash" label="清空表" danger onClick={() => { onClearTable(); closeMore(); }} />
                )}
              </Menu>
            </Popover>
          )}
        </div>
      </div>
    </div>
  );
}

export default GridToolbar;
