// apps/web/src/features/settings/role-permission/RolePermissionSection.tsx
// 工作区设置 → 权限管理 的主容器。
//
// 布局：左栏「角色列表」+ 右栏「这个角色能做什么」（通讯录权限 / 库权限 两段）。
// 旧版是上下两块纵向堆叠，选中一个角色后要滚过整屏才看到它的配置，配到一半就
// 忘了自己在配谁；改左右两栏后「选谁」和「配什么」始终同屏。
//
// fail-closed 纪律：角色清单没回来 / 出错、动作探针没回来，一律按「读不到、改不了」渲染，
// 宁可这一屏暂时只有只读文案，也不能让没权限的人看见可勾的框（后端同样门控，前端不抢跑）。

import { useMemo, useState } from "react";
import { Button, EmptyState, Spinner, toast } from "../../../components/ui";
import { Icon, type IconName } from "../../../components/icons";
import { confirmAction } from "../../../components/feedback";
import { useMyOrgActions, useOrgRoles, useOrgRoleMutations } from "../../contacts/contacts-hooks";
import type { OrgRoleDTO } from "@gx/shared-types";
import { DirectoryPermGrid } from "./DirectoryPermGrid";
import { LibraryScopePanel } from "./LibraryScopePanel";
import { RoleFormModal } from "./RoleFormModal";
import { RoleListPanel } from "./RoleListPanel";
import {
  LOCKED_ROLE_REASON,
  isCustomOrgRole,
  isLockedOrgRole,
  isOrgVisibleRole,
  isPresetOrgRole,
  roleIconName,
} from "../../../lib/role-policy";

export function RolePermissionSection() {
  const { actions, isLoading: actionsLoading } = useMyOrgActions();
  const rolesQ = useOrgRoles();
  const { createRole, updateRole, removeRole } = useOrgRoleMutations();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [form, setForm] = useState<{ role: OrgRoleDTO | null } | null>(null);

  // 与通讯录同一份可见判据（lib/role-policy），不再各写一套。
  const roles = useMemo(() => (rolesQ.data ?? []).filter(isOrgVisibleRole), [rolesQ.data]);
  // 选中项由「pickedId 命中可见集合」推导，不做双向同步：
  // 列表异步到达、或选中的角色被删掉时自然收敛到第一项，不留指向已删角色的残留 id。
  const selected = roles.find((r) => r.id === pickedId) ?? roles[0] ?? null;

  // 动作探针没回来一律当没有写权限（fail-closed）。
  const canCreate = !actionsLoading && actions.has("create_roles");
  const canEdit = !actionsLoading && actions.has("edit_roles");
  const canDelete = !actionsLoading && actions.has("delete_roles");

  if (rolesQ.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  if (rolesQ.isError || roles.length === 0) {
    return (
      <EmptyState
        icon="shield"
        title={rolesQ.isError ? "角色清单没取到" : "还没有可配置的角色"}
        description={
          rolesQ.isError
            ? "权限接口没返回，界面按「无权限」处理，不显示任何可勾选项。请重试。"
            : "需要「查看通讯录」权限才能看到组织里的角色。"
        }
        action={
          <Button variant="secondary" icon="refresh" onClick={() => void rolesQ.refetch()}>
            重试
          </Button>
        }
      />
    );
  }

  async function submitForm(data: { name: string; description: string }) {
    if (!form) return;
    try {
      if (form.role) {
        await updateRole.mutateAsync({ id: form.role.id, data });
        toast("已保存角色", "success");
      } else {
        const created = await createRole.mutateAsync(data);
        setPickedId(created.id);
        toast("角色已创建，接着在右边勾它能做什么", "success");
      }
      setForm(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存失败，请重试", "error");
    }
  }

  async function remove(role: OrgRoleDTO) {
    if (isLockedOrgRole(role)) {
      toast(LOCKED_ROLE_REASON, "error");
      return;
    }
    const ok = await confirmAction({
      title: `删除角色「${role.name}」`,
      confirmText: "删除角色",
      cancelText: "取消",
      level: 2,
      description: "持有这个角色的成员会失去它带来的权限。若还有人只靠这个角色进来，需要先给他们换一个角色。",
    });
    if (!ok) return;
    try {
      await removeRole.mutateAsync({ id: role.id });
      toast("已删除角色", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "删除失败，请先给还挂着这个角色的成员换一个角色", "error");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 className="text-gx-18 font-semibold text-gx-text-primary">权限管理</h2>
        <p className="mt-1 text-gx-13 text-gx-text-tertiary">
          权限只按角色配：先建角色，再把角色授给成员或部门。谁有什么权限，看他属于哪个角色。
        </p>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)] lg:items-start">
        <RoleListPanel
          roles={roles}
          selectedId={selected?.id ?? null}
          onSelect={setPickedId}
          canCreate={canCreate}
          canEdit={canEdit}
          canDelete={canDelete}
          onCreate={() => setForm({ role: null })}
          onEdit={(role) => setForm({ role })}
          onDelete={(role) => void remove(role)}
        />

        {selected && (
          <div className="flex min-w-0 flex-col overflow-hidden rounded-gx-lg border border-gx-separator bg-gx-surface">
            <div className="flex items-start gap-2 border-b border-gx-separator px-4 py-3">
              <Icon name={roleIconName(selected)} size={16} className="mt-0.5 shrink-0 text-gx-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className="text-gx-15 font-semibold text-gx-text-primary">
                    「{selected.name}」的权限
                  </h3>
                  {isLockedOrgRole(selected) && (
                    <span
                      title={LOCKED_ROLE_REASON}
                      className="inline-flex items-center gap-1 rounded-full bg-gx-bg px-2 py-0.5 text-gx-11 font-medium text-gx-text-tertiary"
                    >
                      <Icon name="lock" size={10} />
                      不可编辑、不可删除
                    </span>
                  )}
                  {!isLockedOrgRole(selected) && isPresetOrgRole(selected) && (
                    <span className="rounded-full bg-gx-accent-bg px-2 py-0.5 text-gx-11 font-medium text-gx-accent">
                      系统预设
                    </span>
                  )}
                  {isCustomOrgRole(selected) && (
                    <span className="rounded-full bg-gx-success-bg px-2 py-0.5 text-gx-11 font-medium text-gx-success">
                      自定义
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">
                  {selected.description || "这个角色还没有说明。"}
                </p>
              </div>
              {canEdit && !isLockedOrgRole(selected) && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="edit"
                  className="shrink-0"
                  onClick={() => setForm({ role: selected })}
                >
                  编辑
                </Button>
              )}
            </div>

            <PermBlock
              icon="users"
              title="通讯录权限"
              desc="这个角色对通讯录与组织管理能做什么。"
            >
              {isLockedOrgRole(selected) ? (
                <p className="text-gx-12 text-gx-text-hint">{LOCKED_ROLE_REASON}</p>
              ) : (
                <DirectoryPermGrid key={selected.id} role={selected} canEdit={canEdit} />
              )}
            </PermBlock>

            <PermBlock icon="database" title="库权限" desc="这个角色能进哪些库、在库里能做什么。">
              {isLockedOrgRole(selected) ? (
                <p className="text-gx-12 text-gx-text-hint">
                  超级管理员不用配库权限：它天然能进全部库、管全部库，也是唯一能删库的角色。
                </p>
              ) : (
                <LibraryScopePanel key={selected.id} role={selected} canEdit={canEdit} />
              )}
            </PermBlock>
          </div>
        )}
      </div>

      {form && (
        <RoleFormModal
          key={form.role?.id ?? "new"}
          role={form.role}
          busy={createRole.isPending || updateRole.isPending}
          onClose={() => setForm(null)}
          onSubmit={(data) => void submitForm(data)}
        />
      )}
    </div>
  );
}

/** 右栏的一段配置：图标 + 标题 + 一句说明，段与段之间靠分隔线划开。 */
function PermBlock({
  icon,
  title,
  desc,
  children,
}: {
  icon: IconName;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-gx-separator px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-1.5">
        <Icon name={icon} size={14} className="shrink-0 text-gx-text-tertiary" />
        <h4 className="shrink-0 text-gx-13 font-semibold text-gx-text-primary">{title}</h4>
        <span className="min-w-0 truncate text-gx-11 text-gx-text-hint">{desc}</span>
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}
