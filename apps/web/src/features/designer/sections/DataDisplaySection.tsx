// apps/web/src/features/designer/sections/DataDisplaySection.tsx
// 右栏「数据展示」（form 视图不挂本块）：
//   ① 显示字段 + 列序（管理员层 hiddenFieldIds/fieldOrder，走 commitAdmin）
//   ② 行高 short/medium/tall（config.rowHeight，仅 grid/gallery）
//   ③ 画廊专属（仅 gallery）：封面 / 卡片字段
//   ④ 类型专属字段（按 view.type）：走 commitConfig
//
// 大字段交互（反馈点③）：显示字段用 FieldPickList「已选列表 + 搜索添加」，
// 不再用一长串勾选框。这里「已选」= 当前可见字段；移除即加入 hiddenFieldIds。

import { useMemo } from "react";
import type { RowHeight, ViewAdminConfig, ViewDTO } from "@gx/shared-types";
import type { FieldDTO } from "@gx/shared-types";
import { SegmentedControl } from "../../../components/ui";
import FieldPickList from "../FieldPickList";
import { applyVisibleOrder } from "../viewAdminFields";
import GalleryFieldsSection from "./GalleryFieldsSection";
import TypeSpecificFieldsSection from "./TypeSpecificFieldsSection";

const ROW_HEIGHTS: { value: RowHeight; label: string }[] = [
  { value: "short", label: "紧凑" },
  { value: "medium", label: "常规" },
  { value: "tall", label: "宽松" },
];

export interface DataDisplaySectionProps {
  view: ViewDTO;
  tableId: string;
  fields: FieldDTO[];
  usable: FieldDTO[];
  order: string[];
  admin: ViewAdminConfig;
  canEdit: boolean;
  commitAdmin: (patch: Partial<Omit<ViewAdminConfig, "version">>) => Promise<void>;
  commitConfig: (config: Record<string, unknown>) => Promise<void>;
}

export default function DataDisplaySection({
  view,
  tableId,
  fields,
  usable,
  order,
  admin,
  canEdit,
  commitAdmin,
  commitConfig,
}: DataDisplaySectionProps) {
  // 可见列 = 完整列序去掉强制隐藏列。FieldPickList 只展示/排列这部分。
  const visibleIds = useMemo(
    () => order.filter((id) => !admin.hiddenFieldIds.includes(id)),
    [order, admin.hiddenFieldIds],
  );

  const addVisible = (id: string) =>
    void commitAdmin({
      hiddenFieldIds: admin.hiddenFieldIds.filter((x) => x !== id),
      fieldOrder: order.includes(id) ? order : [...order, id],
    });

  const removeVisible = (id: string) =>
    void commitAdmin({ hiddenFieldIds: [...admin.hiddenFieldIds, id] });

  const reorderVisible = (visibleNext: string[]) =>
    void commitAdmin({ fieldOrder: applyVisibleOrder(order, admin.hiddenFieldIds, visibleNext) });

  const showRowHeight = view.type === "grid" || view.type === "gallery";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-gx-12 font-medium text-gx-text-secondary">显示字段与列序</label>
        <FieldPickList
          fields={usable}
          ids={visibleIds}
          canEdit={canEdit}
          emptyText="所有字段已隐藏，点击「添加字段」恢复"
          onAdd={addVisible}
          onRemove={removeVisible}
          onMove={reorderVisible}
        />
        <div className="text-gx-11 text-gx-text-hint">
          控制所有用户可见的字段与列序；移除的字段对所有人隐藏，可随时搜索找回。
        </div>
      </div>

      {showRowHeight && (
        <div className="flex flex-col gap-2 border-t border-gx-separator pt-3">
          <label className="text-gx-12 font-medium text-gx-text-secondary">行高</label>
          <SegmentedControl
            value={view.config.rowHeight}
            onChange={(h) => void commitConfig({ rowHeight: h })}
            options={ROW_HEIGHTS}
          />
        </div>
      )}

      {view.type === "gallery" && (
        <GalleryFieldsSection
          fields={fields}
          admin={admin}
          canEdit={canEdit}
          commitAdmin={commitAdmin}
        />
      )}

      <TypeSpecificFieldsSection
        view={view}
        tableId={tableId}
        fields={fields}
        canEdit={canEdit}
        commitConfig={commitConfig}
      />
    </div>
  );
}
