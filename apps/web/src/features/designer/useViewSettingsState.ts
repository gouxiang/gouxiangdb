// apps/web/src/features/designer/useViewSettingsState.ts
// 视图设置宽布局各 Section 共用的状态/写通道 Hook。
//
// 统一两类写通道（戴总规格）：
//   · commitAdmin → PATCH /api/views/:id/admin（hiddenFieldIds/fieldOrder/filters/
//     coverFieldId/cardFieldIds/detailFieldIds），本地先 setState + 失败回滚；
//   · commitConfig → PATCH /api/views/:id（rowHeight/groupByFieldId/类型专属字段等）。
// 字段全部加载、orderable 过滤（跳过 tabs 纯容器）也在这里收敛，避免各 Section 重复。

import { useEffect, useMemo, useState } from "react";
import type { FieldDTO, ViewAdminConfig, ViewDTO } from "@gx/shared-types";
import { defaultViewAdminConfig } from "@gx/shared-types";
import { toast } from "../../components/ui";
import { useFields, useGXMutations } from "../../api/hooks";
import { ensureOrder } from "./viewAdminFields";

/** 参与字段显示/详情排序的字段：跳过 tabs 纯容器，subtable 保留。 */
export function orderableFields(fields: FieldDTO[]): FieldDTO[] {
  return fields.filter((f) => f.type !== "tabs");
}

export function useViewSettingsState(view: ViewDTO, tableId: string, canEdit: boolean) {
  const { data: fieldsRes } = useFields(tableId);
  const m = useGXMutations();
  const fields = useMemo(() => fieldsRes ?? [], [fieldsRes]);
  const usable = useMemo(() => orderableFields(fields), [fields]);

  const [admin, setAdmin] = useState<ViewAdminConfig>(
    view.adminConfig ?? defaultViewAdminConfig(),
  );
  // 切换视图后跟随最新（本地未提交时也以新视图为准）。
  useEffect(() => {
    setAdmin(view.adminConfig ?? defaultViewAdminConfig());
  }, [view.id, view.adminConfig]);

  const commitAdmin = async (patch: Partial<Omit<ViewAdminConfig, "version">>) => {
    if (!canEdit) return;
    const prev = admin;
    setAdmin((cur) => ({ ...cur, ...patch }));
    try {
      await m.updateViewAdmin.mutateAsync({ viewId: view.id, tableId, adminConfig: patch });
    } catch (err) {
      setAdmin(prev);
      toast((err as Error).message || "保存管理员配置失败", "error");
    }
  };

  const commitConfig = async (config: Record<string, unknown>) => {
    if (!canEdit) return;
    try {
      await m.updateView.mutateAsync({
        viewId: view.id,
        tableId,
        data: { config: config as never },
      });
    } catch (err) {
      toast((err as Error).message || "保存视图配置失败", "error");
    }
  };

  // fieldOrder 始终覆盖全部参与排序字段，未排序字段按 useFields 顺序追加后再移动。
  const allIds = useMemo(() => usable.map((f) => f.id), [usable]);
  const order = useMemo(() => ensureOrder(admin.fieldOrder, allIds), [admin.fieldOrder, allIds]);

  return {
    m,
    fields,
    usable,
    admin,
    order,
    allIds,
    commitAdmin,
    commitConfig,
  };
}
