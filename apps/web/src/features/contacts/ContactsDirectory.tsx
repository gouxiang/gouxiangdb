// apps/web/src/features/contacts/ContactsDirectory.tsx
// 通讯录可视主体：部门树 / 成员列表 / 角色管理（≥1024px 同屏三栏，窄屏退化为 tab）。
//
// 抽取原因（P2-B2）：工作区设置页要把「成员与部门列表」直接内嵌进来，原先这段逻辑只存在于
// ContactsPage 页面壳里，复制一份就会长出第二套口径。现在页面壳只保留路由与标题，
// 视觉主体在这一个组件里——/workspace/contacts 与设置页分区渲染的是同一份实现。
//
// 注意 window resize 监听必须仍然成对注册/注销：内嵌场景下本组件会随设置页分区切换反复
// 装卸，清理漏一次就是一路叠加的监听器（这里沿用页面版原实现，未改动清理逻辑）。

import { useEffect, useState } from "react";
import { useMyOrgActions, type MemberFilter } from "./contacts-hooks";
import { DeptTree } from "./DeptTree";
import { MemberList } from "./MemberList";
import { RoleManager } from "./RoleManager";
import { Icon } from "../../components/icons";

type Tab = "members" | "roles";

export interface ContactsDirectoryProps {
  /** 嵌入容器的类名；默认自适应父级高度（h-full），可能需要外层给定高度 */
  className?: string;
}

export function ContactsDirectory({ className = "h-full" }: ContactsDirectoryProps) {
  const { actions, isLoading: actionsLoading } = useMyOrgActions();
  // 企业化定位：通讯录入口由 view_directory 单独门控；写动作各自按细分动词投票，
  // 不再用「manage_departments / manage_roles / manage_members」三枚粗粒度位一把梭
  // （自定义角色只勾新十二枚时旧位为空，按旧位判会把这些人全部挡在门外）。
  // 唯一保留的旧位是 manage_members：后端「改某人属于哪个部门」至今仍按它门控，
  // 十二枚细分里没有对应动词（详见 DeptTree 同名注释）。
  const canViewDirectory = actions.has("view_directory");
  const canCreateDepts = actions.has("create_departments");
  const canEditDepts = actions.has("edit_departments");
  const canDeleteDepts = actions.has("delete_departments");
  const canAssignDepartments = actions.has("manage_members");
  const canCreateRoles = actions.has("create_roles");
  const canEditRoles = actions.has("edit_roles");
  const canDeleteRoles = actions.has("delete_roles");
  const canAssignRoleMembers = actions.has("assign_role_members");
  const canInviteUsers = actions.has("invite_users");
  const canCreateUsers = actions.has("create_users");
  const canDisableUsers = actions.has("disable_users");
  const canDeleteUsers = actions.has("delete_users");

  const [deptId, setDeptId] = useState<string | null>(null);
  const [filter, setFilter] = useState<MemberFilter>({ q: "", deptId: null, status: null });

  // 左栏选中部门 → 同步到成员过滤
  useEffect(() => {
    setFilter((f) => ({ ...f, deptId }));
  }, [deptId]);

  const [tab, setTab] = useState<Tab>("members");
  const [isWide, setIsWide] = useState(
    typeof window !== "undefined" ? window.innerWidth >= 1024 : true,
  );
  useEffect(() => {
    const onResize = () => setIsWide(window.innerWidth >= 1024);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (actionsLoading) {
    return (
      <div className={`${className} flex items-center justify-center text-gx-13 text-gx-text-tertiary`}>
        加载通讯录…
      </div>
    );
  }

  // 没有 view_directory 就不该看到任何组织信息——直访 URL 也要挡住，
  // 而不是渲染一个空壳让人以为通讯录是空的。
  if (!canViewDirectory) {
    return (
      <div className={`${className} flex flex-col items-center justify-center gap-1 bg-gx-bg px-6 text-center`}>
        <Icon name="users" size={24} className="text-gx-text-hint" />
        <p className="text-gx-13 font-medium text-gx-text-primary">没有通讯录查看权限</p>
        <p className="max-w-[320px] text-gx-12 text-gx-text-tertiary">
          需要由管理员给你所在的角色勾选「查看通讯录」后才能查看成员与部门。
        </p>
      </div>
    );
  }

  const deptPanel = (
    <div className="h-full min-h-0 w-60 shrink-0 border-r border-gx-separator bg-gx-surface">
      <DeptTree
        selectedDeptId={deptId}
        onSelectDept={setDeptId}
        canCreateDepts={canCreateDepts}
        canEditDepts={canEditDepts}
        canDeleteDepts={canDeleteDepts}
        canAssignDepartments={canAssignDepartments}
      />
    </div>
  );

  const membersPanel = (
    <div className="h-full min-w-0 flex-1 bg-gx-surface">
      <MemberList
        filter={filter}
        onFilterChange={setFilter}
        canAssignDepartments={canAssignDepartments}
        canInviteUsers={canInviteUsers}
        canCreateUsers={canCreateUsers}
        canDisableUsers={canDisableUsers}
        canDeleteUsers={canDeleteUsers}
      />
    </div>
  );

  const rolesPanel = (
    <div className="h-full min-h-0 flex-1 border-l border-gx-separator bg-gx-surface">
      <RoleManager
        canCreateRoles={canCreateRoles}
        canEditRoles={canEditRoles}
        canDeleteRoles={canDeleteRoles}
        canAssignRoleMembers={canAssignRoleMembers}
      />
    </div>
  );

  // 宽屏：同屏三栏
  if (isWide) {
    return (
      <div className={`${className} flex min-h-0 bg-gx-bg`}>
        {deptPanel}
        <div className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1">{membersPanel}</div>
          <div className="flex w-[420px] shrink-0">{rolesPanel}</div>
        </div>
      </div>
    );
  }

  // 窄屏：退化为 tab（成员含左部门树折叠入口）
  return (
    <div className={`${className} flex min-h-0 flex-col bg-gx-bg`}>
      <div className="flex items-center gap-1 border-b border-gx-separator bg-gx-surface px-2 py-1">
        <DirectoryTab active={tab === "members"} icon="users" label="成员与部门" onClick={() => setTab("members")} />
        <DirectoryTab active={tab === "roles"} icon="shield" label="角色" onClick={() => setTab("roles")} />
      </div>
      <div className="min-h-0 flex-1">
        {tab === "members" ? (
          <div className="flex h-full">
            {deptPanel}
            {membersPanel}
          </div>
        ) : (
          rolesPanel
        )}
      </div>
    </div>
  );
}

function DirectoryTab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-gx-sm px-3 py-1.5 text-gx-13 transition-colors ${
        active ? "bg-gx-accent-bg font-medium text-gx-accent" : "text-gx-text-secondary hover:bg-gx-bg"
      }`}
    >
      <Icon name={icon} size={14} />
      {label}
    </button>
  );
}
