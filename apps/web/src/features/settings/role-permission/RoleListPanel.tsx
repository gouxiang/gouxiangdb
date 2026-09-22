// apps/web/src/features/settings/role-permission/RoleListPanel.tsx
// 权限管理 · 左栏：角色列表卡片（系统预设 + 自定义），自定义角色可新建 / 编辑 / 删除。
//
// 显示哪些角色、哪些能改能删，一律走 lib/role-policy 的同一份判据——通讯录共用它，
// 两边不再各写一套。

import { Icon } from "../../../components/icons";
import { Button, IconButton } from "../../../components/ui";
import type { OrgRoleDTO } from "@gx/shared-types";
import {
  LOCKED_ROLE_REASON,
  isCustomOrgRole,
  isLockedOrgRole,
  isPresetOrgRole,
  roleIconName,
} from "../../../lib/role-policy";

export { LOCKED_ROLE_REASON };

export function RoleListPanel({
  roles,
  selectedId,
  onSelect,
  canCreate,
  canEdit,
  canDelete,
  onCreate,
  onEdit,
  onDelete,
}: {
  roles: OrgRoleDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onCreate: () => void;
  onEdit: (role: OrgRoleDTO) => void;
  onDelete: (role: OrgRoleDTO) => void;
}) {
  const presets = roles.filter(isPresetOrgRole);
  const customs = roles.filter(isCustomOrgRole);
  const row = { selectedId, onSelect, canEdit, canDelete, onEdit, onDelete };

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-gx-lg border border-gx-separator bg-gx-surface">
      <div className="flex items-center justify-between gap-2 border-b border-gx-separator px-3 py-2">
        <span className="text-gx-13 font-semibold text-gx-text-primary">角色与权限</span>
        <Button
          size="sm"
          variant="secondary"
          icon="plus"
          disabled={!canCreate}
          disabledReason="需要「新建角色」权限才能新建自定义角色"
          onClick={onCreate}
        >
          新建角色
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <RoleGroup title="系统预设" roles={presets} row={row} />
        <RoleGroup
          title="自定义"
          roles={customs}
          row={row}
          empty="还没有自定义角色。点上方「新建角色」加一个，再在右边勾它能做什么。"
        />
      </div>
    </div>
  );
}

type RowProps = {
  selectedId: string | null;
  onSelect: (id: string) => void;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: (role: OrgRoleDTO) => void;
  onDelete: (role: OrgRoleDTO) => void;
};

function RoleGroup({
  title,
  roles,
  row,
  empty,
}: {
  title: string;
  roles: OrgRoleDTO[];
  row: RowProps;
  empty?: string;
}) {
  return (
    <div className="flex flex-col pb-1">
      <div className="px-3 py-1 text-gx-11 font-medium text-gx-text-tertiary">{title}</div>
      {roles.length === 0 ? (
        <p className="px-3 pb-1 text-gx-11 text-gx-text-hint">{empty ?? "暂无"}</p>
      ) : (
        roles.map((r) => <RoleRow key={r.id} role={r} row={row} />)
      )}
    </div>
  );
}

function RoleRow({ role, row }: { role: OrgRoleDTO; row: RowProps }) {
  const on = row.selectedId === role.id;
  const locked = isLockedOrgRole(role);
  const editBlocked = locked || !row.canEdit;
  const deleteBlocked = locked || !row.canDelete;
  const reason = locked
    ? LOCKED_ROLE_REASON
    : row.canEdit
      ? undefined
      : "需要「编辑角色」权限才能改这个角色";
  const deleteReason = locked
    ? LOCKED_ROLE_REASON
    : row.canDelete
      ? undefined
      : "需要「删除角色」权限才能删这个角色";

  return (
    <div
      className={[
        "group mx-1.5 flex items-center gap-1.5 rounded-gx-lg px-2 py-1.5",
        on ? "bg-gx-accent-bg" : "hover:bg-gx-row-hover",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => row.onSelect(role.id)}
        aria-current={on ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <Icon
          name={roleIconName(role)}
          size={14}
          className={`shrink-0 ${on ? "text-gx-accent" : "text-gx-text-tertiary"}`}
        />
        <span className={`min-w-0 flex-1 truncate text-gx-13 ${on ? "font-semibold text-gx-accent" : "text-gx-text-primary"}`}>
          {role.name}
        </span>
      </button>

      {locked && (
        <span title={LOCKED_ROLE_REASON} className="shrink-0 leading-none">
          <Icon name="lock" size={11} className="text-gx-text-hint" />
        </span>
      )}

      {/* 行内操作默认隐去、悬停/聚焦时浮出：列表主体保持干净，不必每行都挂两颗按钮 */}
      <div
        className={`flex shrink-0 items-center gap-0.5 transition-opacity ${
          on ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
        }`}
      >
        <IconButton
          icon="edit"
          size={13}
          label="编辑角色"
          disabled={editBlocked}
          title={reason}
          onClick={() => row.onEdit(role)}
        />
        <IconButton
          icon="trash"
          size={13}
          danger
          label="删除角色"
          disabled={deleteBlocked}
          title={deleteReason}
          onClick={() => row.onDelete(role)}
        />
      </div>
    </div>
  );
}
