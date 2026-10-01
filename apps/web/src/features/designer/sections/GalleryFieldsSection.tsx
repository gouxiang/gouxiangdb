// apps/web/src/features/designer/sections/GalleryFieldsSection.tsx
// 右栏「数据展示」中的画廊专属块（仅 view.type==="gallery" 渲染）。
//
// 戴总反馈点②：封面 coverFieldId / 卡片字段 cardFieldIds 是画廊专属概念，
// 必须从所有其它视图移除。外层 DataDisplaySection 只在 gallery 挂本块，菜单层也已收敛。
// 两项都属管理员配置层，走 commitAdmin（PATCH /api/views/:id/admin）。

import { useMemo } from "react";
import type { FieldDTO, ViewAdminConfig } from "@gx/shared-types";
import FieldPickList from "../FieldPickList";
import { CoverSelect } from "../viewAdminSections";

export interface GalleryFieldsSectionProps {
  fields: FieldDTO[];
  admin: ViewAdminConfig;
  canEdit: boolean;
  commitAdmin: (patch: Partial<Omit<ViewAdminConfig, "version">>) => Promise<void>;
}

export default function GalleryFieldsSection({
  fields,
  admin,
  canEdit,
  commitAdmin,
}: GalleryFieldsSectionProps) {
  const attachments = useMemo(() => fields.filter((f) => f.type === "attachment"), [fields]);
  // 卡片字段可内联展示——排除附件（已是封面）、tabs 容器、subtable（不适合压进卡片行）。
  const cardCandidates = useMemo(
    () => fields.filter((f) => !["attachment", "tabs", "subtable"].includes(f.type)),
    [fields],
  );

  return (
    <div className="flex flex-col gap-3 border-t border-gx-separator pt-3">
      <div className="text-gx-12 font-semibold text-gx-text-primary">画廊设置</div>

      <div className="flex flex-col gap-1.5">
        <label className="text-gx-12 font-medium text-gx-text-secondary">封面字段</label>
        <CoverSelect
          attachments={attachments}
          value={admin.coverFieldId}
          canEdit={canEdit}
          onChange={(id) => void commitAdmin({ coverFieldId: id })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-gx-12 font-medium text-gx-text-secondary">卡片显示字段</label>
        <FieldPickList
          fields={cardCandidates}
          ids={admin.cardFieldIds}
          canEdit={canEdit}
          emptyText="未选择卡片字段，将显示表名与记录标题"
          onAdd={(id) => void commitAdmin({ cardFieldIds: [...admin.cardFieldIds, id] })}
          onRemove={(id) =>
            void commitAdmin({ cardFieldIds: admin.cardFieldIds.filter((x) => x !== id) })
          }
          onMove={(next) => void commitAdmin({ cardFieldIds: next })}
        />
      </div>
    </div>
  );
}
