// apps/web/src/features/views/ViewRouter.tsx
// 视图分发器：按 view.type 路由到具体视图，并统一管理记录抽屉与跨表跳转
//
// 约定：
//  - 子视图统一接收 ViewProps（baseId/tableId/viewId/view/permissions/onOpenRecord）
//  - 记录抽屉开关由本组件持有；跨表跳转时写入 sessionStorage「gx-pending-record」，
//    目标表加载后由本组件读取并自动打开抽屉

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useViews, useBase, useFields, useTables, useGXMutations } from "../../api/hooks";
import type { DetailLayout, PermissionSet } from "@gx/shared-types";
import { Spinner, toast } from "../../components/ui";
import { ViewLoadFailure } from "./ViewLoadFailure";
import { ViewShell, type ViewShellArgs } from "./ViewShell";
import { DetailLayoutEditor } from "../detail/DetailLayout";

import { GridView } from "../grid/GridView";
import GalleryView from "./GalleryView";
import KanbanView from "./KanbanView";
import CalendarView from "./CalendarView";
import FormView from "./FormView";
import DetailView from "./DetailView";
import RecordDrawer from "../drawer/RecordDrawer";
import type { ViewProps } from "./field-controls";

const EMPTY_PERMISSIONS: PermissionSet = {
  canManageBase: false,
  canManageSchema: false,
  canEditData: false,
  canComment: false,
  canView: true,
};

const PENDING_KEY = "gx-pending-record";

/**
 * 表单设计器宿主：由 URL ?design=1 驱动（侧栏「编辑表单」入口）。
 * 编辑该表首个视图 config.detailLayout；保存后记录抽屉/详情页直接读取该布局。
 * 用 query 而非组件 state，是为了跨表 navigate 时不被 App 层 ErrorBoundary(pathname key) 重挂清掉。
 */
function TableFormDesignerHost({
  baseId,
  tableId,
  permissions,
  onClose,
}: {
  baseId: string;
  tableId: string;
  permissions: PermissionSet;
  onClose: () => void;
}) {
  const { data: views } = useViews(tableId);
  const { data: fieldsRes } = useFields(tableId);
  const { data: tables } = useTables(baseId);
  const m = useGXMutations();

  // 等数据就绪再挂载设计器：FormDesigner 的 items 由 useState 初始化，
  // 字段未就绪时挂载会导致画布为空且之后不回填。
  if (!views || !fieldsRes) return null;
  const targetView = views[0];
  if (!targetView) return null;

  const fields = fieldsRes.filter((f) => !f.isReverse);
  const layout = (targetView.config?.detailLayout as DetailLayout | null) ?? null;

  return (
    <DetailLayoutEditor
      open
      fields={fields}
      layout={layout}
      tableId={tableId}
      baseId={baseId}
      tables={tables ?? []}
      permissions={permissions}
      onClose={onClose}
      // 必须是 mutateAsync：mutate 不返回 Promise 也不抛错，会让设计器在断网/409/500
      // 时照样提示「已保存布局」并关闭面板（P1 静默数据丢失）。
      onSave={async (next) => {
        await m.updateView.mutateAsync({
          viewId: targetView.id,
          tableId,
          data: { config: { ...targetView.config, detailLayout: next } },
        });
      }}
    />
  );
}

export default function ViewRouter() {
  const { baseId, tableId, viewId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const {
    data: views,
    isLoading: viewsLoading,
    isError: viewsError,
    error: viewsErr,
    refetch: refetchViews,
  } = useViews(tableId ?? null);
  const { data: base } = useBase(baseId ?? null);
  const m = useGXMutations();

  const permissions: PermissionSet = base?.permissions ?? EMPTY_PERMISSIONS;
  const view = views?.find((v) => v.id === viewId);

  // 抽屉开关状态
  const [openRecordId, setOpenRecordId] = useState<string | null>(null);

  // ?design=1：全屏表单设计器（侧栏「编辑表单」入口）
  const designOpen = searchParams.get("design") === "1";
  const closeDesigner = useCallback(() => {
    if (!searchParams.get("design")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("design");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // URL 上的 ?record=:id（来自全局搜索 / 文档内部链接）——渲染后打开对应记录抽屉，
  // 否则点了搜索结果只会落到表格页、看不出点了哪条（历史断链）。
  const recordParam = searchParams.get("record");
  const appliedParamRef = useRef<string | null>(null);
  useEffect(() => {
    if (!recordParam) {
      appliedParamRef.current = null;
      return;
    }
    if (appliedParamRef.current === recordParam) return;
    appliedParamRef.current = recordParam;
    setOpenRecordId(recordParam);
  }, [recordParam]);

  /** 把抽屉状态同步到 URL（可分享、刷新保持）；用 replace 避免堆历史 */
  const syncRecordParam = useCallback(
    (recordId: string | null) => {
      const next = new URLSearchParams(searchParams);
      if (recordId) next.set("record", recordId);
      else next.delete("record");
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // 跨表跳转后，目标表加载时读取待打开记录
  useEffect(() => {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return;
    try {
      const pending = JSON.parse(raw) as { tableId: string; recordId: string };
      if (pending.tableId === tableId) {
        setOpenRecordId(pending.recordId);
        sessionStorage.removeItem(PENDING_KEY);
      }
    } catch {
      sessionStorage.removeItem(PENDING_KEY);
    }
  }, [tableId]);

  // 打开记录：同表直接开抽屉；跨表则跳转并在目标表自动打开
  const onOpenRecord = useCallback(
    (ref: { tableId: string; recordId: string; title: string }) => {
      if (ref.tableId !== tableId) {
        sessionStorage.setItem(
          PENDING_KEY,
          JSON.stringify({ tableId: ref.tableId, recordId: ref.recordId }),
        );
        navigate(`/base/${baseId}/table/${ref.tableId}`);
      } else {
        setOpenRecordId(ref.recordId);
        syncRecordParam(ref.recordId);
      }
    },
    [baseId, tableId, navigate, syncRecordParam],
  );

  /** 关闭抽屉：清状态并移除 URL 上的 record 参数（保留其它 query 如 design） */
  const closeDrawer = useCallback(() => {
    setOpenRecordId(null);
    appliedParamRef.current = null;
    if (searchParams.get("record")) syncRecordParam(null);
  }, [searchParams, syncRecordParam]);

  // 抽屉内「新建记录」
  const handleCreateNew = useCallback(async () => {
    if (!tableId || !permissions.canEditData) return;
    try {
      const { record: rec } = await m.createRecord.mutateAsync({ tableId, fields: {}, viewId, draft: true });
      if (rec) {
        setOpenRecordId(rec.id);
        syncRecordParam(rec.id);
      }
    } catch (err) {
      toast((err as Error)?.message || "新建记录失败", "error");
    }
  }, [tableId, viewId, permissions.canEditData, m, syncRecordParam]);

  // 只有「真在加载」才给转圈。
  //
  // 原先这里把「加载中」和「视图拿不到」并成**同一个分支**、一律返回 <Spinner />，
  // 于是任何拉不到视图的情形都会永远卡在那儿：
  //   · PERM-04（WALK-权限组合-2026-09-20）：局外人手输 `/base/:id/table/:id/view/:id`，
  //     `GET /api/views`（views.ts:72 requireCanView）与 `GET /api/bases/:id` 都正确 403，
  //     后端没问题，前端却既不提示「无权限」也不跳转，只留一个永远不停的转圈。
  //   · 同源第二例：视图列表拉到了、但 URL 上的 viewId 已不存在（视图被删过的旧链接），
  //     同样掉进同一个分支永久转圈。
  // 现在两者拆开：加载 → 转圈；失败 → ViewLoadFailure 给终态。
  // 失败态按 ApiError.status 判真值，**不等「先操作再被后端 403 打回」**（那是入口侧要治的病）。
  if (viewsLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (viewsError || !view) {
    return (
      <div className="flex h-full items-start justify-center pt-16">
        <ViewLoadFailure
          error={viewsErr}
          viewMissing={!viewsError && !view}
          onRetry={viewsError ? () => void refetchViews() : undefined}
          onBack={() => navigate("/")}
        />
      </div>
    );
  }

  const viewProps: ViewProps = {
    baseId: baseId ?? "",
    tableId: tableId ?? "",
    viewId: viewId ?? "",
    view,
    permissions,
    onOpenRecord,
  };

  // 六类视图一律走统一外壳（ViewShell）：第一行视图标签条 + 第二行主工具栏（新建记录 /
  // 搜索 / 导入 / 导出 / 更多）对所有视图生效；第三行网格设置行由 GridView 自己渲染。
  // key={view.id}：切视图时整体重挂，外壳持有的视图配置随之回到目标视图的 config。
  const renderContent = ({ config, onUpdateConfig, onNewRecord }: ViewShellArgs): ReactNode => {
    switch (view.type) {
      case "grid":
        return <GridView {...viewProps} config={config} onUpdateConfig={onUpdateConfig} onNewRecord={onNewRecord} />;
      case "gallery":
        return <GalleryView {...viewProps} />;
      case "kanban":
        return <KanbanView {...viewProps} />;
      case "calendar":
        return <CalendarView {...viewProps} />;
      case "form":
        return <FormView {...viewProps} />;
      case "detail":
        return <DetailView {...viewProps} />;
      default:
        return <div className="p-gx-lg text-gx-13 text-gx-text-tertiary">未知视图类型</div>;
    }
  };

  return (
    <div className="relative h-full">
      <ViewShell
        key={view.id}
        baseId={baseId ?? ""}
        tableId={tableId ?? ""}
        viewId={viewId ?? ""}
        view={view}
        permissions={permissions}
      >
        {renderContent}
      </ViewShell>
      <RecordDrawer
        open={!!openRecordId}
        recordId={openRecordId}
        tableId={tableId ?? ""}
        baseId={baseId ?? ""}
        viewId={viewId ?? null}
        permissions={permissions}
        onClose={closeDrawer}
        onCreateNew={permissions.canEditData ? handleCreateNew : undefined}
      />

      {/* 表单设计器：?design=1 时在当前表全屏打开，保存/关闭后仍停留本表 */}
      {designOpen && baseId && tableId && (
        <TableFormDesignerHost
          baseId={baseId}
          tableId={tableId}
          permissions={permissions}
          onClose={closeDesigner}
        />
      )}
    </div>
  );
}
