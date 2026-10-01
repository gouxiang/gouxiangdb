// apps/web/src/features/designer/sections/BasicInfoSection.tsx
// 右栏「基础信息」：视图名称 + 锁定模式（所有视图）。
//
// 写入走普通视图通道 PATCH /api/views/:id（updateView），不走 admin 层：
//   name / lockMode 是视图元信息，不是对所有用户强制的管理员配置。
// 无表结构管理权限时两项置灰（预览仍可见）。

import { useState } from "react";
import type { LockMode, ViewDTO } from "@gx/shared-types";
import { Input, SegmentedControl, toast } from "../../../components/ui";
import { useGXMutations } from "../../../api/hooks";

const LOCK_OPTIONS: { value: LockMode; label: string; desc: string }[] = [
  { value: "collaborative", label: "协作", desc: "所有人共享同一份视图配置。" },
  { value: "locked", label: "已锁定", desc: "仅结构管理者可修改配置。" },
  { value: "personal", label: "个人", desc: "每人独立配置，互不影响。" },
];

export interface BasicInfoSectionProps {
  view: ViewDTO;
  tableId: string;
  canEdit: boolean;
}

export default function BasicInfoSection({ view, tableId, canEdit }: BasicInfoSectionProps) {
  const m = useGXMutations();
  const [name, setName] = useState(view.name);
  const [lockMode, setLockMode] = useState<LockMode>(view.lockMode);

  const rename = async () => {
    if (!name.trim() || name === view.name) {
      if (name !== view.name) setName(view.name);
      return;
    }
    try {
      await m.updateView.mutateAsync({
        viewId: view.id,
        tableId,
        data: { name: name.trim() },
      });
      toast("已重命名视图", "success");
    } catch (err) {
      setName(view.name);
      toast((err as Error).message || "重命名失败", "error");
    }
  };

  const changeLock = (v: LockMode) => {
    setLockMode(v);
    void m.updateView
      .mutateAsync({ viewId: view.id, tableId, data: { lockMode: v } })
      .catch((err) => {
        setLockMode(view.lockMode);
        toast((err as Error).message || "锁定模式修改失败", "error");
      });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-gx-12 font-medium text-gx-text-secondary">视图名称</label>
        <Input
          value={name}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void rename()}
          placeholder="视图名称"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-gx-12 font-medium text-gx-text-secondary">锁定模式</label>
        <SegmentedControl
          value={lockMode}
          onChange={changeLock}
          options={LOCK_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <div className="text-gx-11 text-gx-text-hint">
          {LOCK_OPTIONS.find((o) => o.value === lockMode)?.desc}
        </div>
      </div>
    </div>
  );
}
