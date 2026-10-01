// apps/web/src/features/designer/sections/DetailVisibilitySection.tsx
// 右栏「详情可见性」（所有视图）：详情页字段显示范围 + 顺序。
//
// 戴总明确：默认全部显示，直接移除字段即可对成员隐藏；这里只抄「可见性设置」，
// 不做字段级编辑 / 只读 / 隐藏「权限」切换——权限逻辑有自己的入口（M4 权限面板）。
// detailFieldIds 属管理员配置层，走 commitAdmin。
// 空（detailFieldIds=[]）时后端按全部字段处理；隐式全选态下移除/排序要落成显式数组，
// 不能把空数组 filter 后继续提交（空仍=全部，移除会被静默吞掉）。

import type { FieldDTO, ViewAdminConfig } from "@gx/shared-types";
import FieldPickList from "../FieldPickList";
import { detailBaseIds } from "../viewAdminFields";

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
  const allIds = usable.map((f) => f.id);
  // 当前生效范围：有显式数组用显式，否则全量（隐式全选）。提交时一律落显式数组。
  const baseIds = () => detailBaseIds(admin.detailFieldIds, allIds);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-gx-12 text-gx-text-secondary">
        默认全部显示，移除字段即可对成员隐藏；拖动可调整展示顺序。此处只控制「显示范围」，不涉及字段编辑权限。
      </p>
      <FieldPickList
        fields={usable}
        ids={admin.detailFieldIds}
        canEdit={canEdit}
        defaultAllIds={allIds}
        onAdd={(id) => void commitAdmin({ detailFieldIds: [...baseIds(), id] })}
        onRemove={(id) =>
          void commitAdmin({ detailFieldIds: baseIds().filter((x) => x !== id) })
        }
        onMove={(next) => void commitAdmin({ detailFieldIds: next })}
      />
    </div>
  );
}
