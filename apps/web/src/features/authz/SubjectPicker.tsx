// M4 权限面板主体选择器：成员/部门/角色三页签 + 搜索，点选后加为可编辑策略行。
// 复用既有组织 API（OrgMembers/OrgDepartments/OrgRoles），不新增请求层。
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { OrgDepartments, OrgMembers, OrgRoles } from "../../api/client";
import type { PolicySubjectType } from "@gx/shared-types";
import { Icon } from "../../components/icons";
import { Spinner } from "../../components/ui";

export interface PickedSubject {
  subjectType: PolicySubjectType;
  subjectId: string;
  subjectName: string | null;
}

const TABS: { key: PolicySubjectType; label: string }[] = [
  { key: "user", label: "成员" },
  { key: "dept", label: "部门" },
  { key: "role", label: "角色" },
];

export function SubjectPicker({
  exclude,
  onPick,
}: {
  /** 已在面板内的主体键 type:id，禁重复添加。 */
  exclude: ReadonlySet<string>;
  onPick: (s: PickedSubject) => void;
}) {
  const [tab, setTab] = useState<PolicySubjectType>("user");
  const [q, setQ] = useState("");

  const membersQ = useQuery({
    queryKey: ["picker-members"],
    queryFn: () => OrgMembers.list({ page: 1, limit: 200, q: undefined }),
    enabled: tab === "user",
    staleTime: 30_000,
  });
  const deptsQ = useQuery({
    queryKey: ["picker-depts"],
    queryFn: () => OrgDepartments.list(),
    enabled: tab === "dept",
  });
  const rolesQ = useQuery({
    queryKey: ["picker-roles"],
    queryFn: () => OrgRoles.list(),
    enabled: tab === "role",
  });

  const keyword = q.trim().toLowerCase();
  const memberHits = useMemo(() => {
    const items = membersQ.data?.items ?? [];
    return keyword
      ? items.filter(
          (m) => m.displayName.toLowerCase().includes(keyword) || m.email.toLowerCase().includes(keyword),
        )
      : items;
  }, [membersQ.data, keyword]);
  const deptHits = useMemo(() => {
    const items = deptsQ.data ?? [];
    return keyword ? items.filter((d) => d.name.toLowerCase().includes(keyword)) : items;
  }, [deptsQ.data, keyword]);
  const roleHits = useMemo(() => {
    const items = (rolesQ.data ?? []).filter((r) => !r.deletedAt);
    return keyword ? items.filter((r) => r.name.toLowerCase().includes(keyword)) : items;
  }, [rolesQ.data, keyword]);

  const loading =
    (tab === "user" && membersQ.isLoading) ||
    (tab === "dept" && deptsQ.isLoading) ||
    (tab === "role" && rolesQ.isLoading);

  return (
    <div className="rounded-gx-lg border border-gx-separator">
      <div className="flex items-center gap-1 border-b border-gx-separator px-2 py-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={[
              "rounded-full px-2.5 py-0.5 text-gx-12 transition-colors",
              tab === t.key
                ? "bg-gx-accent-bg font-medium text-gx-accent"
                : "text-gx-text-secondary hover:bg-gx-row-hover",
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 rounded-gx-sm border border-gx-separator bg-gx-surface px-1.5 py-0.5">
          <Icon name="search" size={12} className="shrink-0 text-gx-text-hint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索"
            className="w-28 bg-transparent text-gx-12 text-gx-text-primary outline-none placeholder:text-gx-text-hint"
          />
        </div>
      </div>
      <div className="max-h-52 overflow-y-auto p-1">
        {loading ? (
          <div className="flex h-20 items-center justify-center">
            <Spinner size={16} />
          </div>
        ) : tab === "user" ? (
          <PickerList
            rows={memberHits.map((m) => ({
              key: `user:${m.id}`,
              id: m.id,
              name: m.displayName,
              sub: m.email,
            }))}
            exclude={exclude}
            onPick={(id, name) => onPick({ subjectType: "user", subjectId: id, subjectName: name })}
          />
        ) : tab === "dept" ? (
          <PickerList
            rows={deptHits.map((d) => ({ key: `dept:${d.id}`, id: d.id, name: d.name, sub: `${d.memberCount} 人` }))}
            exclude={exclude}
            onPick={(id, name) => onPick({ subjectType: "dept", subjectId: id, subjectName: name })}
          />
        ) : (
          <PickerList
            rows={roleHits.map((r) => ({
              key: `role:${r.id}`,
              id: r.id,
              name: r.name,
              sub: r.isSystem ? "系统角色" : "自定义角色",
            }))}
            exclude={exclude}
            onPick={(id, name) => onPick({ subjectType: "role", subjectId: id, subjectName: name })}
          />
        )}
      </div>
    </div>
  );
}

function PickerList({
  rows,
  exclude,
  onPick,
}: {
  rows: { key: string; id: string; name: string; sub?: string }[];
  exclude: ReadonlySet<string>;
  onPick: (id: string, name: string) => void;
}) {
  if (rows.length === 0) {
    return <div className="py-6 text-center text-gx-12 text-gx-text-hint">没有匹配的主体</div>;
  }
  return (
    <div className="flex flex-col">
      {rows.map((r) => {
        const added = exclude.has(r.key);
        return (
          <button
            key={r.key}
            type="button"
            disabled={added}
            onClick={() => onPick(r.id, r.name)}
            className="flex items-center gap-2 rounded-gx-sm px-2 py-1 text-left hover:bg-gx-row-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="plus" size={13} className="shrink-0 text-gx-text-hint" />
            <span className="min-w-0 flex-1 truncate text-gx-13 text-gx-text-primary">{r.name}</span>
            {r.sub && <span className="shrink-0 text-gx-11 text-gx-text-hint">{r.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}
