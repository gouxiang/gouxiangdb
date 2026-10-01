// apps/web/src/features/designer/sections/FilterSection.tsx
// 右栏「查询条件」（所有视图）：管理员层强制筛选。
//
// 直接复用 FilterPanel（与网格侧栏同一组件），传 fields / value / filteredTotal=0 / onChange。
// filters 属管理员配置层，走 commitAdmin（PATCH /api/views/:id/admin）。
// 生效口径：对所有用户生效，与用户自己的筛选 AND 叠加。

import type { FieldDTO, ViewAdminConfig } from "@gx/shared-types";
import FilterPanel from "../../grid/FilterPanel";

export interface FilterSectionProps {
  fields: FieldDTO[];
  admin: ViewAdminConfig;
  commitAdmin: (patch: Partial<Omit<ViewAdminConfig, "version">>) => Promise<void>;
}

export default function FilterSection({ fields, admin, commitAdmin }: FilterSectionProps) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-gx-12 text-gx-text-secondary">
        在此设置的筛选对所有用户生效，与用户自己的筛选叠加。
      </p>
      <FilterPanel
        fields={fields}
        value={admin.filters}
        filteredTotal={0}
        onChange={(f) => void commitAdmin({ filters: f })}
      />
    </div>
  );
}
