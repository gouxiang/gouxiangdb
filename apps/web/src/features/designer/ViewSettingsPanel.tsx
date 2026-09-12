// apps/web/src/features/designer/ViewSettingsPanel.tsx
// 视图设置面板：重命名、锁定模式、复制/删除视图

import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useViews, useGXMutations } from "../../api/hooks";
import type { LockMode, PermissionSet, ViewDTO } from "@gx/shared-types";
import { Button, Input, SegmentedControl, toast } from "../../components/ui";

export interface ViewSettingsPanelProps {
  view: ViewDTO;
  tableId: string;
  permissions: PermissionSet;
  onClose: () => void;
}

const LOCK_OPTIONS: { value: LockMode; label: string; desc: string }[] = [
  { value: "collaborative", label: "协作", desc: "所有人共享同一份视图配置。" },
  { value: "locked", label: "已锁定", desc: "仅结构管理者可修改配置。" },
  { value: "personal", label: "个人", desc: "每人独立配置，互不影响。" },
];

export default function ViewSettingsPanel({ view, tableId, permissions, onClose }: ViewSettingsPanelProps) {
  const { baseId } = useParams();
  const navigate = useNavigate();
  const { data: views } = useViews(tableId);
  const m = useGXMutations();

  const [name, setName] = useState(view.name);
  const [lockMode, setLockMode] = useState<LockMode>(view.lockMode);

  const canSchema = permissions.canManageSchema;
  const viewCount = views?.length ?? 1;
  const onlyOne = viewCount <= 1;

  const rename = async () => {
    if (!name.trim() || name === view.name) return;
    try {
      await m.updateView.mutateAsync({ viewId: view.id, tableId, data: { name: name.trim() } });
      toast("已重命名视图", "success");
    } catch (err) {
      toast((err as Error).message || "重命名失败", "error");
    }
  };

  const duplicate = async () => {
    try {
      await m.duplicateView.mutateAsync({ viewId: view.id, tableId });
      toast("已复制视图", "success");
      onClose();
    } catch (err) {
      toast((err as Error).message || "复制失败", "error");
    }
  };

  const remove = async () => {
    if (onlyOne) return;
    try {
      await m.deleteView.mutateAsync({ viewId: view.id, tableId });
      toast("已删除视图", "success");
      // 跳回表首页（会自动定位到首个视图）
      navigate(`/base/${baseId}/table/${tableId}`);
      onClose();
    } catch (err) {
      toast((err as Error).message || "删除失败", "error");
    }
  };

  return (
    <div className="flex w-72 flex-col gap-4 rounded-gx-xl border border-gx-border bg-gx-surface p-4 shadow-lg">
      <div className="text-gx-14 font-semibold text-gx-text-primary">视图设置</div>

      {/* 名称 */}
      <div className="flex flex-col gap-1.5">
        <label className="text-gx-12 font-medium text-gx-text-secondary">视图名称</label>
        <Input
          value={name}
          disabled={!canSchema}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          placeholder="视图名称"
        />
      </div>

      {/* 锁定模式 */}
      <div className="flex flex-col gap-2">
        <label className="text-gx-12 font-medium text-gx-text-secondary">锁定模式</label>
        <SegmentedControl
          value={lockMode}
          onChange={(v) => {
            setLockMode(v);
            void m.updateView.mutateAsync({ viewId: view.id, tableId, data: { lockMode: v } });
          }}
          options={LOCK_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <div className="text-gx-11 text-gx-text-hint">
          {LOCK_OPTIONS.find((o) => o.value === lockMode)?.desc}
        </div>
      </div>

      {/* 操作 */}
      <div className="flex flex-col gap-2 border-t border-gx-separator pt-3">
        <Button
          variant="secondary"
          block
          disabled={!canSchema}
          onClick={duplicate}
        >
          复制视图
        </Button>
        <Button
          variant="danger"
          block
          disabled={!canSchema || onlyOne}
          onClick={remove}
          title={onlyOne ? "至少保留一个视图" : undefined}
        >
          {onlyOne ? "删除视图（至少保留一个）" : "删除视图"}
        </Button>
        {!canSchema && <div className="text-gx-11 text-gx-text-hint">无表结构管理权限</div>}
      </div>
    </div>
  );
}
