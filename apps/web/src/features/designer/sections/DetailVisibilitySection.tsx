// apps/web/src/features/designer/sections/DetailVisibilitySection.tsx
// 右栏「详情可见性」（所有视图）：详情页字段显示范围 + 顺序。
//
// 戴总明确：这里只抄「可见性设置」，不做字段级编辑 / 只读 / 隐藏「权限」切换——
// 权限逻辑有自己的入口（M4 权限面板）。detailFieldIds 属管理员配置层，走 commitAdmin。
// 空（detailFieldIds=[]）时后端按全部字段处理，因此候选集仍是该表全部可用字段。

import type { FieldDTO, ViewAdminConfig } from "@gx/shared-types";
import FieldPickList from "../FieldPickList";

export interface DetailVisibilitySectionProps {
  usable: FieldDTO[];
  admin: ViewAdminConfig;
  canEdit: boolean;
  commitAdmin: (patch: Partial<Omit<ViewAdminConfig, "version">>) => Promise<void>;
}

export default function DetailVisibilitySection({
  usable,
  admin,
  canEdit,
  commitAdmin,
}: DetailVisibilitySectionProps) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-gx-12 text-gx-text-secondary">
        选择记录详情页显示哪些字段，拖动可调整展示顺序。此处只控制「显示范围」，不涉及字段编辑权限。
      </p>
      <FieldPickList
        fields={usable}
        ids={admin.detailFieldIds}
        canEdit={canEdit}
        emptyText="未限定范围，详情页默认显示全部字段"
        onAdd={(id) => void commitAdmin({ detailFieldIds: [...admin.detailFieldIds, id] })}
        onRemove={(id) =>
          void commitAdmin({ detailFieldIds: admin.detailFieldIds.filter((x) => x !== id) })
        }
        onMove={(next) => void commitAdmin({ detailFieldIds: next })}
      />
    </div>
  );
}
