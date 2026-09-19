// M2/S7 工作区通讯录页：同屏三栏（部门树 / 成员列表 / 角色管理，≥1024px），窄屏退化为 tab（不做移动端）。
// 数据全部走 contacts-hooks（TanStack Query）→ client.ts 的 /api/v1/org/*；写按组织动作门控。
import { useEffect, useState } from "react";
import { useMyOrgActions, type MemberFilter } from "./contacts-hooks";
import { DeptTree } from "./DeptTree";
import { MemberList } from "./MemberList";
import { RoleManager } from "./RoleManager";
import { Icon } from "../../components/icons";

type Tab = "members" | "roles";

export default function ContactsPage() {
  const { actions, isLoading: actionsLoading } = useMyOrgActions();
  const canManageDepts = actions.has("manage_departments");
  const canManageMembers = actions.has("manage_members");
  const canManageRoles = actions.has("manage_roles");

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
      <div className="flex h-full items-center justify-center text-gx-13 text-gx-text-tertiary">
        加载通讯录…
      </div>
    );
  }

  const deptPanel = (
    <div className="h-full min-h-0 w-60 shrink-0 border-r border-gx-separator bg-gx-surface">
      <DeptTree
        selectedDeptId={deptId}
        onSelectDept={setDeptId}
        canManage={canManageDepts}
        canManageMembers={canManageMembers}
      />
    </div>
  );

  const membersPanel = (
    <div className="h-full min-w-0 flex-1 bg-gx-surface">
      <MemberList
        filter={filter}
        onFilterChange={setFilter}
        canManageMembers={canManageMembers}
      />
    </div>
  );

  const rolesPanel = (
    <div className="h-full min-h-0 flex-1 border-l border-gx-separator bg-gx-surface">
      <RoleManager canManageRoles={canManageRoles} />
    </div>
  );

  // 宽屏：同屏三栏
  if (isWide) {
    return (
      <div className="flex h-full min-h-0 bg-gx-bg">
        {deptPanel}
        <div className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1">{membersPanel}</div>
          <div className="flex w-[420px] shrink-0">{rolesPanel}</div>
        </div>
      </div>
    );
  }

  // 窄屏：退化为 tab（成员含左部门树折叠入口；M2 不做移动端细节）
  return (
    <div className="flex h-full min-h-0 flex-col bg-gx-bg">
      <div className="flex items-center gap-1 border-b border-gx-separator bg-gx-surface px-2 py-1">
        <TabButton active={tab === "members"} icon="users" label="成员与部门" onClick={() => setTab("members")} />
        <TabButton active={tab === "roles"} icon="shield" label="角色" onClick={() => setTab("roles")} />
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

function TabButton({
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
