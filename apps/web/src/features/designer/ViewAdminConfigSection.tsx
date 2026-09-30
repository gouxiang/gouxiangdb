// apps/web/src/features/designer/ViewAdminConfigSection.tsx
// 视图「管理员配置层」面板（#560）：仅表结构管理者可见。
//
// 管理的是对所有用户强制生效的配置层（ViewAdminConfig，独立于普通用户 ViewConfig）：
//   A 字段显示范围与列序  B 画廊封面  C 画廊卡片字段  D 详情字段范围  E 视图级强制筛选
// 写入走独立端点 PATCH /api/views/:viewId/admin（Views.updateAdmin / updateViewAdmin），
// 不触碰普通用户 config 的 Views.update 通道。本地先乐观更新，失败 toast 回滚。

import { useEffect, useMemo, useState } from "react";
import type { FieldDTO, ViewAdminConfig, ViewDTO } from "@gx/shared-types";
import { defaultViewAdminConfig } from "@gx/shared-types";
import { toast } from "../../components/ui";
import { useFields, useGXMutations } from "../../api/hooks";
import FilterPanel from "../grid/FilterPanel";
import { ensureOrder, moveField, toggleHidden, toggleId } from "./viewAdminFields";
import { CoverSelect, FieldCheckList, FieldOrderList } from "./viewAdminSections";

export interface ViewAdminConfigSectionProps {
  view: ViewDTO;
  tableId: string;
  /** 仅 canManageSchema 时为 true；无权限时外层根本不渲染本组件。 */
  canEdit: boolean;
}

/** A/D 参与排序与详情展示的字段：跳过 tabs 纯容器，subtable 保留。 */
function orderable(fields: FieldDTO[]): FieldDTO[] {
  return fields.filter((f) => f.type !== "tabs");
}

function SectionTitle({ children }: { children: string }) {
  return <div className="text-gx-12 font-medium text-gx-text-secondary">{children}</div>;
}

export default function ViewAdminConfigSection({
  view,
  tableId,
  canEdit,
}: ViewAdminConfigSectionProps) {
  const { data: fieldsRes } = useFields(tableId);
  const m = useGXMutations();
  const fields = useMemo(() => fieldsRes ?? [], [fieldsRes]);
  const usable = useMemo(() => orderable(fields), [fields]);

  const [admin, setAdmin] = useState<ViewAdminConfig>(
    view.adminConfig ?? defaultViewAdminConfig(),
  );
  // 切换视图后跟随最新（本地未提交时也以新视图为准）。
  useEffect(() => {
    setAdmin(view.adminConfig ?? defaultViewAdminConfig());
  }, [view.id, view.adminConfig]);

  const commit = async (patch: Partial<Omit<ViewAdminConfig, "version">>) => {
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

  // fieldOrder 始终覆盖全部参与排序字段，未排序字段按 useFields 顺序追加后再移动。
  const allIds = useMemo(() => usable.map((f) => f.id), [usable]);
  const order = useMemo(() => ensureOrder(admin.fieldOrder, allIds), [admin.fieldOrder, allIds]);

  const attachments = useMemo(() => fields.filter((f) => f.type === "attachment"), [fields]);
  // 卡片字段：可内联展示——排除附件（已是封面）、tabs 容器、subtable（不适合压进卡片行）。
  const cardCandidates = useMemo(
    () => fields.filter((f) => !["attachment", "tabs", "subtable"].includes(f.type)),
    [fields],
  );

  return (
    <div className="flex flex-col gap-2 border-t border-gx-separator pt-3">
      <div className="text-gx-13 font-semibold text-gx-text-primary">管理员配置</div>

      {/* A：字段显示范围与顺序 */}
      <SectionTitle>字段显示范围与顺序</SectionTitle>
      <FieldOrderList
        fields={usable}
        order={order}
        hidden={admin.hiddenFieldIds}
        canEdit={canEdit}
        onToggleHidden={(id) => void commit({ hiddenFieldIds: toggleHidden(admin.hiddenFieldIds, id) })}
        onMove={(id, dir) => void commit({ fieldOrder: moveField(order, id, dir) })}
      />
      <div className="text-gx-11 text-gx-text-hint">
        这里控制所有用户可见的字段与列序；勾掉的字段对所有人隐藏。
      </div>

      {/* B：封面 */}
      <SectionTitle>画廊封面</SectionTitle>
      <CoverSelect
        attachments={attachments}
        value={admin.coverFieldId}
        canEdit={canEdit}
        onChange={(id) => void commit({ coverFieldId: id })}
      />

      {/* C：画廊卡片字段 */}
      <SectionTitle>画廊卡片字段</SectionTitle>
      <FieldCheckList
        fields={cardCandidates}
        selected={admin.cardFieldIds}
        canEdit={canEdit}
        onToggle={(id) => void commit({ cardFieldIds: toggleId(admin.cardFieldIds, id) })}
      />

      {/* D：详情字段范围与顺序 */}
      <SectionTitle>详情字段范围与顺序</SectionTitle>
      <FieldCheckList
        fields={usable}
        selected={admin.detailFieldIds}
        canEdit={canEdit}
        onToggle={(id) => void commit({ detailFieldIds: toggleId(admin.detailFieldIds, id) })}
      />
      <div className="text-gx-11 text-gx-text-hint">勾中的字段按上方字段顺序出现在详情页。</div>

      {/* E：视图级强制筛选 */}
      <SectionTitle>视图级强制筛选</SectionTitle>
      <div className="text-gx-11 text-gx-text-hint">
        对所有用户生效，与用户自己的筛选同时叠加。
      </div>
      <FilterPanel
        fields={fields}
        value={admin.filters}
        filteredTotal={0}
        onChange={(f) => void commit({ filters: f })}
      />
    </div>
  );
}
