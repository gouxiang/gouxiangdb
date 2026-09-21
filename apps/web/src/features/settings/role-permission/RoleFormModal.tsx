// apps/web/src/features/settings/role-permission/RoleFormModal.tsx
// 自定义角色的新建 / 改名改说明弹窗。
//
// 刻意只收「名称 + 说明」两项，不在这里勾权限：
// 权限分通讯录与库两段，配好各自有各自的保存，塞进建角色的弹窗会让
// 「建好了但没配」和「配了但没保存」两种半成品状态混在一起。
// 建完角色直接在下方权限区勾，当场看得见生效范围。

import { useState } from "react";
import { Button, Input, Modal, Textarea } from "../../../components/ui";
import type { OrgRoleDTO } from "@gx/shared-types";

export function RoleFormModal({
  role,
  busy,
  onClose,
  onSubmit,
}: {
  /** null = 新建；有值 = 编辑 */
  role: OrgRoleDTO | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (data: { name: string; description: string }) => void;
}) {
  // 初值只在挂载时灌一次：父组件按 role 身份给 key（新建 / 编辑不同角色各自 remount），
  // 不做「role 变化 → 覆盖用户正在输入的内容」的双向同步。
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");

  const trimmed = name.trim();
  const invalid = trimmed.length === 0 || trimmed.length > 60;

  return (
    <Modal
      open
      title={role ? "编辑角色" : "新建角色"}
      onClose={onClose}
      width={440}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={invalid}
            disabledReason={trimmed.length > 60 ? "角色名称不能超过 60 字" : "角色名称不能为空"}
            onClick={() => onSubmit({ name: trimmed, description: description.trim() })}
          >
            {role ? "保存" : "创建"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-gx-12 font-medium text-gx-text-secondary">角色名称</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：财务、外部协作者"
            aria-label="角色名称"
            autoFocus
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gx-12 font-medium text-gx-text-secondary">说明（可选）</span>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="这个角色大致负责什么，方便别人看懂"
            aria-label="角色说明"
          />
        </label>
        {!role && (
          <p className="text-gx-11 text-gx-text-hint">
            新建的角色默认什么都做不了。创建后在下方「通讯录权限」与「库权限」里勾它能做什么。
          </p>
        )}
      </div>
    </Modal>
  );
}
