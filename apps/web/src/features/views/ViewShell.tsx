// apps/web/src/features/views/ViewShell.tsx
// 统一视图外壳：六类视图（grid / gallery / kanban / calendar / form / detail）共用同一个框架。
//   第一行 = 视图标签条（数据表图标入口 + ViewSwitcher）——所有视图都显示
//   第二行 = 主工具栏：左端「新建记录」，右端（ml-auto）「搜索 / 导入 / 导出 / 更多」——所有视图都显示
//   第三行 = 网格专属设置行（行高 / 字段 / 筛选 / 分组 / 排序 / 行颜色）——仅 grid 渲染
//   第四行起 = 各视图自己的内容（+ 视图私有功能条，如日历的月份切换）
//
// 背景（2026-09-21 产品走查）：标签条与主工具栏原先是 GridView 的私有子树，切到非网格视图后
// 整体消失，五种视图像"不在整体框架内"。现在前两行由外壳统一装配；第三行仍由 GridView 渲染：
//   那六项是网格行列概念，数据来自网格自己的无限滚动查询（filteredTotal / degradedCodes）与
//   网格内的字段编辑器。上提到外壳，要么让外壳为每种视图多拉一份列表查询，要么把网格私有状态
//   反压给父组件（子 → 父传节点），两者都比"留在原地、紧跟第二行渲染"更差。
//
// 「新建记录 / 搜索 / 导入 / 导出」与视图类型无关，故可统一：
//   · 新建记录 = 建一条空草稿行（draft 跳过创建期必填），与视图类型无关
//   · 搜索写入 view.config.search，服务端 queryRecords 对所有视图都按 config.search 过滤
//     （apps/api/src/domain/recordService.ts:194 `opts.search ?? opts.config.search`），
//     写入后 updateView 失效 views + records，非网格视图随之重拉
//   · 导入 / 导出作用于整张表

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { PermissionSet, ViewConfig, ViewDTO } from "@gx/shared-types";
import { useGXMutations, useTables } from "../../api/hooks";
import { toast } from "../../components/ui";
import { useWriteGuard } from "../../components/interaction";
import { confirmClearTable } from "../../components/confirm-table";
import { isUseStatePatch, pickUseState } from "./view-config-route";
import { EntityIconPicker } from "../../components/EntityIconPicker";
import { ViewSwitcher } from "../grid/ViewSwitcher";
import { GridToolbar } from "../grid/GridToolbar";
import { TableViewIoDialogs } from "../grid/GridView";
import { TableShareModal } from "../sharing/TableShareModal";
import { ViewSettingsModal } from "../shell/ViewSettingsModal";

export interface ViewShellArgs {
  /** 视图配置（外壳持有并写回服务端；第二行的搜索框写 config.search） */
  config: ViewConfig;
  onUpdateConfig: (partial: Partial<ViewConfig>) => void;
  /** 新建记录：与视图类型无关，网格空态等子视图入口复用同一实现 */
  onNewRecord: () => void;
}

export interface ViewShellProps {
  baseId: string;
  tableId: string;
  viewId: string;
  view: ViewDTO;
  permissions: PermissionSet;
  children: (args: ViewShellArgs) => ReactNode;
}

export function ViewShell({
  baseId,
  tableId,
  viewId,
  view,
  permissions,
  children,
}: ViewShellProps) {
  const m = useGXMutations();
  const { data: tablesData } = useTables(baseId);
  // R-I-26：新建记录走写在途守卫（连点不产生两条草稿行）
  const newRecordGuard = useWriteGuard();
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // 分享弹窗由外壳持有：六类视图的「更多」菜单都指向同一份，不需要每类视图各挂一个。
  const [shareOpen, setShareOpen] = useState(false);
  // 视图设置弹窗由外壳持有：入口在视图标签右侧「⋯」菜单里（重命名旁边）。
  // ★ 存「目标视图 id」而不是布尔量：菜单挂在每个 tab 上，触发的可能是非当前视图，
  //   直接用 setSettingsOpen(true) 会让「看板视图」的菜单打开「网格视图」的设置。
  const [settingsViewId, setSettingsViewId] = useState<string | null>(null);

  const currentTable = (tablesData ?? []).find((t) => t.id === tableId) ?? null;

  // 配置：外壳持有，乐观更新后写回服务端（口径与原 GridView.updateConfig 一致）。
  // 切视图时宿主带 key={view.id} 重挂，这里只需兜住「服务端配置被别的入口改过」
  // （例如看板视图自己改了分组字段），否则下一次搜索写回会把那次改动覆盖掉。
  const [config, setConfig] = useState<ViewConfig>(view.config);
  const serverConfigRef = useRef<ViewConfig>(view.config);
  useEffect(() => {
    if (view.config !== serverConfigRef.current) {
      serverConfigRef.current = view.config;
      setConfig(view.config);
    }
  }, [view.config]);

  const onUpdateConfig = useCallback(
    (partial: Partial<ViewConfig>) => {
      const next = { ...config, ...partial };
      setConfig(next);

      // #561：纯「使用态」改动（搜索/筛选/排序/行高/分组折叠/分组字段/聚合）且当前用户
      // 无结构管理权时，只写他自己的 prefs，不覆盖共享 views.config；
      // canSchema 或任何结构层键（字段范围/顺序/封面/详情/行颜色…）仍走原共享通道。
      if (isUseStatePatch(partial) && !permissions.canManageSchema) {
        m.saveViewPrefs
          .mutateAsync({ viewId, tableId, prefs: pickUseState(next) })
          .catch((e: unknown) => {
            // 乐观失败：回滚到本次写入前的快照，避免界面停在没存住的状态。
            setConfig(config);
            toast((e as Error)?.message ?? "保存视图偏好失败", "error");
          });
        return;
      }

      m.updateView
        .mutateAsync({ viewId, tableId, data: { config: next } })
        .catch((e: unknown) => {
          setConfig(config);
          toast((e as Error)?.message ?? "保存视图配置失败", "error");
        });
    },
    [config, m, viewId, tableId, permissions.canManageSchema],
  );

  const onNewRecord = useCallback(() => {
    void newRecordGuard.run("new-record", () =>
      m.createRecord
        .mutateAsync({ tableId, fields: {}, viewId, draft: true })
        .catch((e: unknown) => toast((e as Error)?.message || "新建记录失败", "error")),
    );
  }, [newRecordGuard, m, tableId, viewId]);

  const onCopyView = () => void m.duplicateView.mutateAsync({ viewId, tableId });

  // R-D-23 / R-D-24：与顶栏、表设置行共用 confirmClearTable，同一动作不出现两套文案。
  // 不传 scopedToView：清空接口本身不看视图，实际总是清整张表。
  const onClearTable = () => {
    const tableName = currentTable?.name ?? "该数据表";
    void confirmClearTable({ tableName }).then((ok) => {
      if (!ok) return;
      void m.clearTable
        .mutateAsync({ tableId, viewId })
        .then(() => toast("已清空数据，记录已移入回收站", "success"))
        .catch((e: unknown) => toast((e as Error)?.message ?? "清空失败", "error"));
    });
  };

  return (
    // v6 #984：底板 .wrap > .card——外层灰底留白（margin 16/20/20 落 padding），
    // 内层整页白卡片 r12 + 发丝边，overflow-hidden 让三行/卡底状态栏自动收圆角。
    <div className="flex h-full min-h-0 flex-col bg-gx-bg px-5 pb-5 pt-4">
     <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-gx-2xl border border-gx-hairline bg-gx-surface">
      <GridToolbar
        leading={
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {/* 数据表「图标与颜色」入口：触发器自带 resolved 图标预览，同时是本表页的图标展示位。
                上提到外壳后六类视图都能改表图标（原先只有网格有）。无表结构管理权限即不渲染。
                v6 #984：底板 .vicon 26×26/r8/brand-soft 底/brand 字（tone=brandSoft + .gx-vicon）。 */}
            {currentTable && permissions.canManageSchema ? (
              <EntityIconPicker
                icon={currentTable.icon}
                iconColor={currentTable.iconColor}
                defaultIcon="table"
                ariaLabel="数据表图标与颜色"
                triggerSize={26}
                tone="brandSoft"
                className="gx-vicon mr-1.5"
                onChange={(next) =>
                  m.updateTable.mutateAsync({
                    tableId,
                    data: { icon: next.icon, iconColor: next.iconColor },
                  })
                }
              />
            ) : null}
            <ViewSwitcher
              baseId={baseId}
              tableId={tableId}
              viewId={viewId}
              canManageSchema={permissions.canManageSchema}
              onViewSettings={(id) => setSettingsViewId(id || viewId)}
            />
          </div>
        }
        config={config}
        permissions={{
          canEditData: permissions.canEditData,
          canManageSchema: permissions.canManageSchema,
        }}
        newRecordBusy={newRecordGuard.isBusy("new-record")}
        onUpdateConfig={onUpdateConfig}
        onNewRecord={onNewRecord}
        onImport={() => setImportOpen(true)}
        onExport={() => setExportOpen(true)}
        onCopyView={onCopyView}
        onClearTable={onClearTable}
        onShare={() => setShareOpen(true)}
      />

      {/* 视图内容：第三行起（网格自己再渲染一行设置项，其余视图直接进内容区）。
          在卡片内纵向填充，min-h-0 让网格虚拟滚动区正确收高度。 */}
      <div className="flex min-h-0 flex-1 flex-col">{children({ config, onUpdateConfig, onNewRecord })}</div>
     </div>

      {/* 以下均为 portal 弹窗：留在卡片外（根下），不被卡的 overflow-hidden 裁剪。 */}
      {/* 导入 / 导出向导：表级操作，外壳为六类视图统一挂载一份 */}
      <TableViewIoDialogs
        baseId={baseId}
        tableId={tableId}
        viewId={viewId}
        viewName={view.name}
        tableName={currentTable?.name ?? null}
        importOpen={importOpen}
        exportOpen={exportOpen}
        onCloseImport={() => setImportOpen(false)}
        onCloseExport={() => setExportOpen(false)}
      />

      {/* 数据表分享：档位两档（只读 / 可编辑），可编辑要求分享人本人此刻有编辑权，
          且分享人之后被降权时链接会自动回落只读——判定全在后端（GET /share 的 canGrantEdit），
          这里不传权限位、不自己猜，只负责渲染与置灰。 */}
      <TableShareModal
        tableId={tableId}
        viewId={viewId}
        open={shareOpen}
        onClose={() => setShareOpen(false)}
      />

      {/* 视图设置：入口在视图标签右侧「⋯」菜单（重命名旁边）。此前是工具栏上的独立按钮，
          放在外面不够直觉。目标视图由菜单回传，可能与当前视图不同。 */}
      <ViewSettingsModal
        open={settingsViewId !== null}
        tableId={tableId}
        viewId={settingsViewId ?? viewId}
        permissions={permissions}
        onClose={() => setSettingsViewId(null)}
      />
    </div>
  );
}

export default ViewShell;
