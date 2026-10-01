// apps/web/src/features/designer/ViewSettingsWide.tsx
// 视图设置宽布局三栏骨架：左预览 / 中归类菜单 / 右配置内容。
//
// 由无 title 的 Modal 承载（ViewSettingsModal 传 width=960、ariaLabel），本组件自绘关闭按钮。
// 高度占满 Modal 内容区（Modal 内容区有 px-4 py-3，用负边距拉满），三栏各自独立滚动：
//   左栏 ~38% 静态预览；中栏 160px 菜单；右栏 flex-1 内部滚动并常驻底部操作区。

import { useEffect, useState } from "react";
import type { PermissionSet, ViewDTO } from "@gx/shared-types";
import { IconButton } from "../../components/ui";
import { Icon } from "../../components/icons";
import ViewSettingPreview from "./ViewSettingPreview";
import { defaultViewSettingsTab, viewSettingsTabs } from "./viewSettingsTabs";
import { useViewSettingsState } from "./useViewSettingsState";
import type { ViewSettingTabKey } from "./viewSettingsTabs";
import BasicInfoSection from "./sections/BasicInfoSection";
import DataDisplaySection from "./sections/DataDisplaySection";
import DetailVisibilitySection from "./sections/DetailVisibilitySection";
import FilterSection from "./sections/FilterSection";
import ViewDangerActions from "./sections/ViewDangerActions";
import FormConfigSection from "../views/FormConfigSection";

export interface ViewSettingsWideProps {
  view: ViewDTO;
  tableId: string;
  permissions: PermissionSet;
  onClose: () => void;
}

export default function ViewSettingsWide({
  view,
  tableId,
  permissions,
  onClose,
}: ViewSettingsWideProps) {
  const tabs = viewSettingsTabs(view.type);
  const [tab, setTab] = useState<ViewSettingTabKey>(defaultViewSettingsTab(view.type));
  // 切换视图后重置到该类型的默认菜单。
  useEffect(() => setTab(defaultViewSettingsTab(view.type)), [view.id, view.type]);

  const canEdit = permissions.canManageSchema;
  const st = useViewSettingsState(view, tableId, canEdit);

  return (
    <div className="flex h-full min-h-0">
      {/* 左栏：静态预览 */}
      <div className="min-h-0 w-[38%] shrink-0 p-4">
        <ViewSettingPreview view={view} fields={st.usable} />
      </div>

      {/* 中栏：归类菜单 */}
      <nav className="flex min-h-0 w-40 shrink-0 flex-col gap-1 border-l border-gx-separator py-4 pr-2">
        {tabs.map((t) => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "flex items-center gap-2 rounded-gx-sm bg-gx-accent-bg px-2.5 py-2 text-left text-gx-12 text-gx-accent"
                  : "flex items-center gap-2 rounded-gx-sm px-2.5 py-2 text-left text-gx-12 text-gx-text-secondary hover:bg-gx-bg"
              }
            >
              <Icon name={t.icon} size={14} />
              {t.label}
            </button>
          );
        })}
      </nav>

      {/* 右栏：配置内容（内部滚动） */}
      <div className="flex min-h-0 flex-1 flex-col border-l border-gx-separator">
        <div className="flex items-center justify-end px-3 pt-3">
          <IconButton icon="close" label="关闭" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-2">
          <SectionContent
            tab={tab}
            view={view}
            tableId={tableId}
            canEdit={canEdit}
            state={st}
            permissions={permissions}
            onClose={onClose}
          />
        </div>
      </div>
    </div>
  );
}

interface SectionContentProps {
  tab: ViewSettingTabKey;
  view: ViewDTO;
  tableId: string;
  canEdit: boolean;
  permissions: PermissionSet;
  onClose: () => void;
  state: ReturnType<typeof useViewSettingsState>;
}

function SectionContent({
  tab,
  view,
  tableId,
  canEdit,
  permissions,
  onClose,
  state: st,
}: SectionContentProps) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-gx-14 font-semibold text-gx-text-primary">
        {viewSettingsTabs(view.type).find((t) => t.key === tab)?.label}
      </h2>

      {tab === "basic" && (
        <BasicInfoSection view={view} tableId={tableId} canEdit={canEdit} />
      )}
      {tab === "display" && (
        <DataDisplaySection
          view={view}
          tableId={tableId}
          fields={st.fields}
          usable={st.usable}
          order={st.order}
          admin={st.admin}
          canEdit={canEdit}
          commitAdmin={st.commitAdmin}
          commitConfig={st.commitConfig}
        />
      )}
      {tab === "detail" && (
        <DetailVisibilitySection
          usable={st.usable}
          admin={st.admin}
          canEdit={canEdit}
          commitAdmin={st.commitAdmin}
        />
      )}
      {tab === "filters" && (
        <FilterSection fields={st.fields} admin={st.admin} commitAdmin={st.commitAdmin} />
      )}
      {tab === "form" && (
        <FormConfigSection view={view} tableId={tableId} canEdit={canEdit} />
      )}

      <ViewDangerActions
        view={view}
        tableId={tableId}
        permissions={permissions}
        onClose={onClose}
      />
    </div>
  );
}
