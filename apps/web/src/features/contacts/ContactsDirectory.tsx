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
      <div className={`${className} flex items-center justify-center text-gx-13 text-gx-text-tertiary`}>
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
