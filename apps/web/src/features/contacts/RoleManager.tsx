// M2/S7 通讯录右栏：五系统角色锁定（仅说明）+ 自定义角色 CRUD（三枚组织动作）+ 角色主体维护（选人/选部门节点）。
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  Input,
  Modal,
  Spinner,
  Textarea,
  toast,
} from "../../components/ui";
import { Icon } from "../../components/icons";
import { Form, FormActions, FormField, FormRow, FormSection } from "../../components/form";
import { ORG_ACTIONS, type OrgAction, type OrgRoleDTO } from "@gx/shared-types";
import {
  useDepartments,
  useOrgMembers,
  useOrgRoleMutations,
  useOrgRoles,
  useRoleAssignments,
  type MemberFilter,
} from "./contacts-hooks";
import { buildDeptTree, flattenVisible } from "./lib/tree";
import { errText } from "./contacts-ui";
import { confirmIrreversible } from "../../components/feedback";

const ACTION_LABEL: Record<OrgAction, string> = {
  manage_departments: "管理部门",
  manage_members: "管理成员",
  manage_roles: "管理角色",
  manage_menu: "导航编排",
  manage_share: "分享授权",
};

const NO_FILTER: MemberFilter = { q: "", deptId: null, status: null };

export function RoleManager({ canManageRoles }: { canManageRoles: boolean }) {
  const rolesQ = useOrgRoles();
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ role: OrgRoleDTO | null } | null>(null);

  const roles = useMemo(() => rolesQ.data ?? [], [rolesQ.data]);
  useEffect(() => {
    if (!selectedRoleId && roles.length) setSelectedRoleId(roles[0]!.id);
  }, [roles, selectedRoleId]);

  if (rolesQ.isLoading) {
    return <div className="flex h-full items-center justify-center"><Spinner size={20} /></div>;
  }

  return (
    <div className="flex h-full">
      {/* 角色列表 */}
      <div className="flex w-44 shrink-0 flex-col border-r border-gx-separator">
        <div className="flex items-center justify-between border-b border-gx-separator px-3 py-2">
          <span className="text-gx-13 font-semibold text-gx-text-primary">角色</span>
          {canManageRoles && (
            <IconButton icon="plus" size={15} label="新建自定义角色" onClick={() => setEditing({ role: null })} />
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {roles.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setSelectedRoleId(r.id)}
              className={`flex w-full items-center gap-1.5 px-3 py-2 text-left text-gx-13 ${
                selectedRoleId === r.id ? "bg-gx-accent-bg font-medium text-gx-accent" : "text-gx-text-primary hover:bg-gx-row-hover"
              }`}
            >
              {r.isSystem ? <Icon name="crown" size={13} className="shrink-0 text-gx-warning" /> : <Icon name="shield" size={13} className="shrink-0 opacity-60" />}
              <span className="flex-1 truncate">{r.name}</span>
              {r.isSystem && <Icon name="lock" size={11} className="shrink-0 text-gx-text-hint" />}
            </button>
          ))}
        </div>
      </div>

      {/* 角色详情/主体维护 */}
      <div className="min-w-0 flex-1">
        {selectedRoleId ? (
          <RoleDetail
            role={roles.find((r) => r.id === selectedRoleId) ?? null}
            canManage={canManageRoles}
            onEdit={() => {
              const r = roles.find((x) => x.id === selectedRoleId) ?? null;
              if (r && !r.isSystem) setEditing({ role: r });
            }}
          />
        ) : (
          <EmptyState icon="shield" title="选择一个角色" />
        )}
      </div>

      {editing && (
        <RoleEditModal role={editing.role} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function RoleDetail({
  role,
  canManage,
  onEdit,
}: {
  role: OrgRoleDTO | null;
  canManage: boolean;
  onEdit: () => void;
}) {
  const assignmentsQ = useRoleAssignments(role?.id ?? null);

  if (!role) return <EmptyState icon="shield" title="角色不存在" />;
  const userCount = (assignmentsQ.data ?? []).filter((a) => a.subjectType === "user").length;
  const deptCount = (assignmentsQ.data ?? []).filter((a) => a.subjectType === "dept").length;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-gx-separator px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-gx-14 font-semibold text-gx-text-primary">{role.name}</span>
          {role.isSystem && (
            <span className="rounded-full bg-gx-warning-bg px-2 py-0.5 text-gx-11 font-medium text-gx-warning">系统角色</span>
          )}
          {canManage && !role.isSystem && (
            <Button size="sm" variant="ghost" icon="edit" className="ml-auto" onClick={onEdit}>编辑</Button>
          )}
        </div>
        <p className="mt-1 text-gx-12 text-gx-text-tertiary">{role.description || "无说明"}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {role.actions.length === 0 ? (
            <span className="text-gx-12 text-gx-text-hint">无组织管理动作</span>
          ) : (
            role.actions.map((a) => (
              <span key={a} className="rounded-full bg-gx-accent-bg px-2 py-0.5 text-gx-11 font-medium text-gx-accent">
                {ACTION_LABEL[a]}
              </span>
            ))
          )}
        </div>
      </div>

      <AssignmentEditor
        role={role}
        canManage={canManage}
      />

      <div className="border-t border-gx-separator px-3 py-2 text-gx-11 text-gx-text-hint">
        {assignmentsQ.isLoading ? "加载授予中…" : `已授予 ${userCount} 名成员、${deptCount} 个部门（部门授予对其子树全体成员生效）`}
      </div>
    </div>
  );
}

/** 角色主体维护：列出当前 user/dept 授予，可移除、可添加（选人或选部门节点）。 */
function AssignmentEditor({ role, canManage }: { role: OrgRoleDTO; canManage: boolean }) {
  const assignmentsQ = useRoleAssignments(role.id);
  const members = useOrgMembers(NO_FILTER);
  const { data: depts } = useDepartments();
  const m = useOrgRoleMutations();
  const [pickerOpen, setPickerOpen] = useState(false);

  const assignments = useMemo(() => assignmentsQ.data ?? [], [assignmentsQ.data]);
  const memberName = useMemo(() => {
    const map = new Map(members.items.map((u) => [u.id, u.displayName || u.email]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [members.items]);
  const deptName = useMemo(() => {
    const map = new Map((depts ?? []).map((d) => [d.id, d.name]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [depts]);

  // 待提交的主体集（勾选态），保存时整体 PUT 替换。
  const [draft, setDraft] = useState<Set<string> | null>(null);
  useEffect(() => {
    setDraft(new Set(assignments.map((a) => `${a.subjectType}:${a.subjectId}`)));
  }, [assignments]);

  const deptRows = useMemo(() => {
    const tree = buildDeptTree(depts ?? []);
    return flattenVisible(tree, new Set((depts ?? []).map((d) => d.id)));
  }, [depts]);

  const keyOf = (t: "user" | "dept", id: string) => `${t}:${id}`;
  const toggle = (t: "user" | "dept", id: string) => {
    setDraft((prev) => {
      const next = new Set(prev ?? []);
      const k = keyOf(t, id);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  async function save(subjects: Array<{ subjectType: "user" | "dept"; subjectId: string }>) {
    try {
      await m.replaceAssignments.mutateAsync({ roleId: role.id, subjects });
      toast("已更新角色成员", "success");
      setPickerOpen(false);
    } catch (e) {
      toast(errText(e, "保存失败"), "error");
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-gx-13 font-semibold text-gx-text-primary">授予对象</span>
        {canManage && (
          <Button size="sm" variant="secondary" icon="plus" onClick={() => setPickerOpen(true)}>添加成员/部门</Button>
        )}
      </div>

      {assignments.length === 0 ? (
        <p className="text-gx-12 text-gx-text-hint">尚未授予给任何人或部门。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {assignments.map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded-gx-sm px-2 py-1.5 hover:bg-gx-bg">
              <Icon name={a.subjectType === "user" ? "user" : "building"} size={14} className="shrink-0 text-gx-text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-gx-13 text-gx-text-primary">
                {a.subjectType === "user" ? memberName(a.subjectId) : deptName(a.subjectId)}
              </span>
              <span className="shrink-0 text-gx-11 text-gx-text-hint">
                {a.subjectType === "user" ? "成员" : "部门（含子树）"}
              </span>
              {canManage && (
                <button
                  type="button"
                  aria-label="移除授予"
                  className="shrink-0 rounded p-0.5 text-gx-text-tertiary hover:bg-gx-surface hover:text-gx-danger"
                  onClick={() => {
                    const rest = assignments
                      .filter((x) => x.id !== a.id)
                      .map((x) => ({ subjectType: x.subjectType, subjectId: x.subjectId }));
                    void save(rest);
                  }}
                >
                  <Icon name="close" size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && pickerOpen && draft && (
        <SubjectPicker
          draft={draft}
          deptRows={deptRows}
          members={members.items}
          memberName={memberName}
          deptName={deptName}
          onToggle={toggle}
          busy={m.replaceAssignments.isPending}
          onCancel={() => setPickerOpen(false)}
          onSave={() => {
            const subjects = [...draft].map((k) => {
              const [t, id] = k.split(":");
              return { subjectType: t as "user" | "dept", subjectId: id as string };
            });
            void save(subjects);
          }}
        />
      )}
    </div>
  );
}

/** 添加主体弹层：成员（搜索）+ 部门节点（树形缩进）勾选。 */
function SubjectPicker({
  draft,
  deptRows,
  members,
  memberName,
  deptName,
  onToggle,
  onSave,
  onCancel,
  busy,
}: {
  draft: Set<string>;
  deptRows: Array<{ dept: { id: string; name: string }; depth: number }>;
  members: Array<{ id: string; displayName: string; email: string; status: string }>;
  memberName: (id: string) => string;
  deptName: (id: string) => string;
  onToggle: (t: "user" | "dept", id: string) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const [tab, setTab] = useState<"user" | "dept">("user");
  const [q, setQ] = useState("");
  const filtered = q.trim()
    ? members.filter((u) => (u.displayName + u.email).toLowerCase().includes(q.trim().toLowerCase()))
    : members;

  return (
    <Modal
      open
      onClose={onCancel}
      title="添加授予对象"
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>取消</Button>
          <Button variant="primary" loading={busy} onClick={onSave}>保存</Button>
        </>
      }
    >
      <div className="mb-2 inline-flex rounded-gx-lg border border-gx-border bg-gx-surface p-0.5">
        {([["user", "选成员"], ["dept", "选部门节点"]] as const).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setTab(v)}
            className={`rounded-gx-sm px-3 py-1 text-gx-12 font-medium ${tab === v ? "bg-gx-accent-bg text-gx-accent" : "text-gx-text-tertiary hover:bg-gx-bg"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "user" ? (
        <div className="flex flex-col gap-2">
          <Input placeholder="搜索成员姓名/邮箱…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="max-h-72 overflow-y-auto rounded-gx-lg border border-gx-separator">
            {filtered.map((u) => (
              <label key={u.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-gx-bg">
                <Checkbox checked={draft.has(`user:${u.id}`)} onChange={() => onToggle("user", u.id)} />
                <span className="flex-1 truncate text-gx-13 text-gx-text-primary">{memberName(u.id)}</span>
                <span className="truncate text-gx-11 text-gx-text-hint">{u.email}</span>
              </label>
            ))}
            {filtered.length === 0 && <p className="p-3 text-gx-12 text-gx-text-hint">无匹配成员</p>}
          </div>
        </div>
      ) : (
        <div className="max-h-80 overflow-y-auto rounded-gx-lg border border-gx-separator">
          {deptRows.map(({ dept, depth }) => (
            <label key={dept.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-gx-bg" style={{ paddingLeft: 8 + depth * 16 }}>
              <Checkbox checked={draft.has(`dept:${dept.id}`)} onChange={() => onToggle("dept", dept.id)} />
              <Icon name="building" size={13} className="shrink-0 text-gx-text-tertiary" />
              <span className="truncate text-gx-13 text-gx-text-primary">{deptName(dept.id)}</span>
            </label>
          ))}
          {deptRows.length === 0 && <p className="p-3 text-gx-12 text-gx-text-hint">暂无部门</p>}
        </div>
      )}
    </Modal>
  );
}

/** 新建/编辑自定义角色 Modal：名称/说明/三枚组织动作（系统角色不由此编辑）。 */
function RoleEditModal({ role, onClose }: { role: OrgRoleDTO | null; onClose: () => void }) {
  const m = useOrgRoleMutations();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [actions, setActions] = useState<Set<OrgAction>>(new Set(role?.actions ?? []));
  // R-F-10 ①失焦即校验；③已报错字段在输入时实时消错（error 由当前值推导，输入即重算）
  const [nameTouched, setNameTouched] = useState(false);

  const nameOk = name.trim().length > 0 && name.trim().length <= 60;
  const nameError = nameTouched && !name.trim() ? "角色名称不能为空" : null;

  function toggleAction(a: OrgAction) {
    setActions((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a); else next.add(a);
      return next;
    });
  }

  async function submit() {
    const acts = ORG_ACTIONS.filter((a) => actions.has(a));
    try {
      if (role) {
        await m.updateRole.mutateAsync({ id: role.id, data: { name: name.trim(), description, actions: acts } });
        toast("已更新角色", "success");
      } else {
        await m.createRole.mutateAsync({ name: name.trim(), description, actions: acts });
        toast("已创建角色", "success");
      }
      onClose();
    } catch (e) {
      toast(errText(e, "保存失败"), "error");
    }
  }

  async function remove() {
    if (!role) return;
    // 角色删除无撤销接口（后端若有授予悬挂会返 409），按 L4 不可恢复确认
    const ok = await confirmIrreversible({
      title: "删除角色",
      confirmText: "删除角色",
      description: `自定义角色「${role.name}」会被删除，此操作不可撤销。若仍有成员挂着该角色，删除会失败并提示你先迁移。`,
    });
    if (!ok) return;
    try {
      await m.removeRole.mutateAsync({ id: role.id });
      toast("已删除角色", "success");
      onClose();
    } catch (e) {
      // 409：仍有授予悬挂，提示先在下方移除/迁移（后端文案含条数）
      toast(errText(e, "删除失败"), "error");
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={role ? "编辑自定义角色" : "新建自定义角色"}
      width={460}
      footer={
        <FormActions
          align="right"
          submitText="保存"
          onSubmit={submit}
          submitting={m.createRole.isPending || m.updateRole.isPending}
          submitDisabled={!nameOk}
          submitDisabledReason={!name.trim() ? "请先填写角色名称" : undefined}
          onCancel={onClose}
          leading={
            role ? (
              <Button variant="danger" icon="trash" loading={m.removeRole.isPending} onClick={() => void remove()}>
                删除
              </Button>
            ) : undefined
          }
        />
      }
    >
      {/* 阶段 2：弹窗表单走统一骨架（12 栅格 + 控件 34 + 错误行 16px 预留） */}
      <Form variant="modal" padding={false}>
        <FormSection>
          <FormRow>
            <FormField
              label="角色名称"
              required
              error={nameError}
              help="用于成员列表与权限审计中的展示"
              labelExtra={`${name.length}/60`}
            >
              <Input
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setNameTouched(true)}
                placeholder="例如：人事管理员"
              />
            </FormField>
          </FormRow>
          <FormRow>
            <FormField
              label="说明"
              optional
              control="auto"
              help="不超过 200 字"
              labelExtra={`${description.length}/200`}
            >
              <Textarea
                rows={2}
                maxLength={200}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="例如：负责花名册维护与入离职办理"
              />
            </FormField>
          </FormRow>
          <FormRow>
            <FormField
              label="组织管理动作"
              help="M2 自定义角色仅可授予组织管理动作；资源（Base/表/文档）权限不受此影响。"
            >
              <div className="flex flex-col gap-1">
                {ORG_ACTIONS.map((a) => (
                  <label key={a} className="flex items-center gap-2 rounded-gx-sm px-1 py-1 hover:bg-gx-bg">
                    <Checkbox checked={actions.has(a)} onChange={() => toggleAction(a)} />
                    <span className="text-gx-13 text-gx-text-primary">{ACTION_LABEL[a]}</span>
                    <span className="text-gx-11 text-gx-text-hint">{a}</span>
                  </label>
                ))}
              </div>
            </FormField>
          </FormRow>
        </FormSection>
      </Form>
    </Modal>
  );
}
