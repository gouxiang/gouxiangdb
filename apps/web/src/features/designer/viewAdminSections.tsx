// apps/web/src/features/designer/viewAdminSections.tsx
// 视图管理员配置的可复用展示子块。宽布局重构后字段列表统一改用 FieldPickList，
// 这里仅保留画廊封面选择器（CoverSelect），供 GalleryFieldsSection 使用。
//
// 受控组件：状态与提交由调用方持有，这里只负责渲染与回调。

import type { FieldDTO } from "@gx/shared-types";
import { Select } from "../../components/ui";

/** 画廊封面（attachment 字段或无）。无 attachment 字段时禁用并说明。 */
export function CoverSelect({
  attachments,
  value,
  canEdit,
  onChange,
}: {
  attachments: FieldDTO[];
  value: string | null;
  canEdit: boolean;
  onChange: (id: string | null) => void;
}) {
  return (
    <Select
      value={value ?? ""}
      disabled={!canEdit || attachments.length === 0}
      disabledReason="该表暂无附件字段"
      onChange={(e) => onChange(e.target.value || null)}
      options={[
        { value: "", label: "无封面" },
        ...attachments.map((f) => ({ value: f.id, label: f.name })),
      ]}
    />
  );
}
