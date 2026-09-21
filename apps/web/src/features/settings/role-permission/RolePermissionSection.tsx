// apps/web/src/features/settings/role-permission/RolePermissionSection.tsx
// 工作区设置 → 权限管理 的主容器。
//
// 上下两块，对应两件不同的事：
//   上半「角色与权限」——组织里有哪些角色，自定义角色增删改名；
//   下半「<角色名> 的权限」——选中某个角色后配它能做什么，分通讯录（A）与库（B）两段。
//
// fail-closed 纪律：角色清单没回来 / 出错、动作探针没回来，一律按「读不到、改不了」渲染，
// 宁可这一屏暂时只有只读文案，也不能让没权限的人看见可勾的框（后端同样门控，前端不抢跑）。

import { useMemo, useState } from "react";
import { Button, EmptyState, Spinner, toast } from "../../../components/ui";
import { Icon } from "../../../components/icons";
import { confirmAction } from "../../../components/feedback";
import { useMyOrgActions, useOrgRoles, useOrgRoleMutations } from "../../contacts/contacts-hooks";
import type { OrgRoleDTO } from "@gx/shared-types";
import { DirectoryPermGrid } from "./DirectoryPermGrid";
import { LibraryScopePanel } from "./LibraryScopePanel";
import { RoleFormModal } from "./RoleFormModal";
import { LOCKED_ROLE_REASON, RoleListPanel, isVisibleRole } from "./RoleListPanel";

/** 块头：图标 + 标题 + 一句大白话说明。 */
function Block({
  icon,
  title,
  desc,
  children,
}: {
  icon: "users" | "database";
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <Icon name={icon} size={15} className="mt-0.5 shrink-0 text-gx-accent" />
        <div className="min-w-0">
          <h3 className="text-gx-14 font-semibold text-gx-text-primary">{title}</h3>
          <p className="mt-0.5 text-gx-12 text-gx-text-tertiary">{desc}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export function RolePermissionSection() {
  const { actions, isLoading: actionsLoading } = useMyOrgActions();
  const rolesQ = useOrgRoles();
  const { createRole, updateRole, removeRole } = useOrgRoleMutations();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [form, setForm] = useState<{ role: OrgRoleDTO | null } | null>(null);

  const roles = useMemo(() => (rolesQ.data ?? []).filter(isVisibleRole), [rolesQ.data]);
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
        toast("角色已创建，接着在下面勾它能做什么", "success");
      }
      setForm(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : "保存失败，请重试", "error");
    }
  }

  async function remove(role: OrgRoleDTO) {
    if (role.immutable) {
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
    <div className="flex min-w-0 flex-col gap-5">
      <div>
        <h2 className="text-gx-18 font-semibold text-gx-text-primary">权限管理</h2>
        <p className="mt-1 text-gx-13 text-gx-text-tertiary">
          权限只按角色配：先建角色，再把角色授给成员或部门。谁有什么权限，看他属于哪个角色。
        </p>
      </div>

      <Block
        icon="users"
        title="角色与权限"
        desc="组织里全部角色都在这里。超级管理员是系统内置的，改不了也删不掉。"
      >
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
      </Block>

      {selected && (
        <Block
          icon="database"
          title={`「${selected.name}」的权限`}
          desc="分两段：它对通讯录能做什么，以及它能进哪些库、在库里能做什么。"
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <div className="text-gx-13 font-medium text-gx-text-primary">通讯录权限</div>
              {selected.immutable ? (
                <p className="text-gx-12 text-gx-text-hint">{LOCKED_ROLE_REASON}</p>
              ) : (
                <DirectoryPermGrid key={selected.id} role={selected} canEdit={canEdit} />
              )}
            </div>

            <div className="flex flex-col gap-1">
              <div className="text-gx-13 font-medium text-gx-text-primary">库权限</div>
              {selected.immutable ? (
                <p className="text-gx-12 text-gx-text-hint">
                  超级管理员不用配库权限：它天然能进全部库、管全部库，也是唯一能删库的角色。
                </p>
              ) : (
                <LibraryScopePanel key={selected.id} role={selected} canEdit={canEdit} />
              )}
            </div>
          </div>
        </Block>
      )}

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
