// apps/web/src/features/settings/role-permission/RoleListPanel.tsx
// 权限管理 · 上半：角色与权限。
//
// 列出全部角色（三枚预设 + 自定义），自定义角色可新建 / 编辑 / 删除；
// 超级管理员不可编辑、不可删除——置灰并写明原因，不做「点了才报错」的假入口。

import { Icon, type IconName } from "../../../components/icons";
import { Button, IconButton } from "../../../components/ui";
import type { OrgRoleDTO } from "@gx/shared-types";

/**
 * 面板要展示的预设角色：三枚权限预设（超级管理员 / 管理员 / 受限成员）+ owner
 * （超级管理员的旧 systemKey，存量库里仍可能挂着）。
 * creator/editor/commenter/viewer 是资源授权策略的主体锚点，组织层零动作，此处不展示。
 */
const PRESET_KEYS = new Set(["super_admin", "admin", "restricted", "owner"]);

export function isVisibleRole(r: OrgRoleDTO): boolean {
  return !r.systemKey || PRESET_KEYS.has(r.systemKey);
}

export function isPresetRole(r: OrgRoleDTO): boolean {
  return !!r.systemKey && PRESET_KEYS.has(r.systemKey);
}

function roleIcon(r: OrgRoleDTO): IconName {
  if (r.systemKey === "super_admin" || r.systemKey === "owner") return "crown";
  if (r.systemKey === "admin") return "shield";
  if (r.systemKey === "restricted") return "userSlash";
  return "shield";
}

/** 不可编辑 / 不可删除的原因（后端按 roles.immutable 判据，界面口径必须同源）。 */
export const LOCKED_ROLE_REASON =
  "超级管理员是系统内置角色，不能改名字和权限，也不能删除——否则可能被摘掉权限位，把真正的管理员锁在系统外面。";

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
  const presets = roles.filter(isPresetRole);
  const customs = roles.filter((r) => !isPresetRole(r));
  const row = { selectedId, onSelect, canEdit, canDelete, onEdit, onDelete };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-gx-12 text-gx-text-tertiary">
          角色决定一个人能做什么。选中一个角色，在下面配置它的通讯录权限与库权限。
        </p>
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

      <RoleGroup title="系统预设角色" roles={presets} row={row} />
      <RoleGroup
        title="自定义角色"
        roles={customs}
        row={row}
        empty="还没有自定义角色。点右上角「新建角色」加一个，再在下面勾它能做什么。"
      />
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
    <div className="flex flex-col gap-1">
      <div className="text-gx-12 font-medium text-gx-text-secondary">{title}</div>
      {roles.length === 0 ? (
        <p className="rounded-gx-lg border border-gx-separator px-3 py-2 text-gx-12 text-gx-text-hint">
          {empty ?? "暂无"}
        </p>
      ) : (
        <div className="overflow-hidden rounded-gx-lg border border-gx-separator">
          {roles.map((r) => (
            <RoleRow key={r.id} role={r} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function RoleRow({ role, row }: { role: OrgRoleDTO; row: RowProps }) {
  const on = row.selectedId === role.id;
  const locked = role.immutable;
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
        "flex items-center gap-2 border-b border-gx-separator px-3 py-2 last:border-0",
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
          name={roleIcon(role)}
          size={14}
          className={`shrink-0 ${on ? "text-gx-accent" : "text-gx-text-tertiary"}`}
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-gx-13 ${on ? "font-semibold text-gx-accent" : "text-gx-text-primary"}`}
          >
            {role.name}
            {locked && (
              <Icon name="lock" size={11} className="ml-1 inline-block align-[-1px] text-gx-text-hint" />
            )}
          </span>
          {role.description && (
            <span className="block truncate text-gx-11 text-gx-text-hint">{role.description}</span>
          )}
        </span>
      </button>

      {locked && (
        <span
          title={LOCKED_ROLE_REASON}
          className="shrink-0 rounded-full bg-gx-bg px-2 py-0.5 text-gx-11 text-gx-text-tertiary"
        >
          不可编辑、不可删除
        </span>
      )}

      <IconButton
        icon="edit"
        size={14}
        label="编辑角色"
        disabled={editBlocked}
        title={reason}
        onClick={() => row.onEdit(role)}
      />
      <IconButton
        icon="trash"
        size={14}
        danger
        label="删除角色"
        disabled={deleteBlocked}
        title={deleteReason}
        onClick={() => row.onDelete(role)}
      />
    </div>
  );
}
