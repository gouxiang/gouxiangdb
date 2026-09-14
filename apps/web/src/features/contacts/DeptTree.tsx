// M2/S7 通讯录左栏：部门树（平铺数据前端组树/展开），新建/改名/移动（父下拉前端拦环）/软删（409 引导）。
import { useMemo, useState } from "react";
import {
  Button,
  IconButton,
  Input,
  Modal,
  Popover,
  Menu,
  MenuItem,
  Spinner,
  EmptyState,
  toast,
} from "../../components/ui";
import { Icon } from "../../components/icons";
import type { DeptDTO } from "@gx/shared-types";
import { useDepartments, useOrgDeptMutations } from "./contacts-hooks";
import {
  buildDeptTree,
  flattenVisible,
  movableParentCandidates,
  wouldFormCycle,
} from "./lib/tree";
import { errText } from "./contacts-ui";

interface DeptTreeProps {
  selectedDeptId: string | null;
  onSelectDept: (id: string | null) => void;
  canManage: boolean;
}

export function DeptTree({ selectedDeptId, onSelectDept, canManage }: DeptTreeProps) {
  const { data: flat, isLoading, isError, error } = useDepartments();
  const m = useOrgDeptMutations();

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [creatingParent, setCreatingParent] = useState<string | null | undefined>(undefined);
  const [renaming, setRenaming] = useState<DeptDTO | null>(null);
  const [moving, setMoving] = useState<DeptDTO | null>(null);
  const [deleting, setDeleting] = useState<DeptDTO | null>(null);

  // 稳定化派生数组（?? [] 每次渲染产生新引用会触发 exhaustive-deps）。
  const depts = useMemo(() => flat ?? [], [flat]);
  const tree = useMemo(() => buildDeptTree(depts), [depts]);
  // 默认把存在的部门全部展开（管理层级通常不多；用户可折叠）。
  const effectiveExpanded = useMemo(() => {
    if (expanded.size === 0 && depts.length) return new Set(depts.map((d) => d.id));
    return expanded;
  }, [expanded, depts]);
  const rows = useMemo(
    () => flattenVisible(tree, effectiveExpanded),
    [tree, effectiveExpanded],
  );

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev.size ? prev : depts.map((d) => d.id));
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (isLoading) {
    return <div className="flex h-full items-center justify-center"><Spinner size={20} /></div>;
  }
  if (isError) {
    return (
      <div className="p-4 text-gx-13 text-gx-danger">{errText(error, "部门加载失败")}</div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-gx-separator px-3 py-2">
        <span className="text-gx-13 font-semibold text-gx-text-primary">部门</span>
        {canManage && (
          <IconButton
            icon="plus"
            size={15}
            label="新建顶级部门"
            onClick={() => setCreatingParent("ROOT")}
          />
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <button
          type="button"
          onClick={() => onSelectDept(null)}
          className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-gx-13 ${
            selectedDeptId === null ? "bg-gx-accent-bg font-medium text-gx-accent" : "text-gx-text-primary hover:bg-gx-row-hover"
          }`}
        >
          <Icon name="users" size={14} className="opacity-70" />
          <span className="flex-1">全部成员</span>
        </button>

        {rows.length === 0 && (
          <EmptyState
            icon="building"
            title="还没有部门"
            description={canManage ? "新建一个顶级部门开始组织通讯录" : "管理员尚未创建部门"}
          />
        )}

        {rows.map(({ dept, depth }) => {
          const active = selectedDeptId === dept.id;
          const hasChildren = depts.some((d) => d.parentId === dept.id);
          const isOpen = effectiveExpanded.has(dept.id);
          return (
            <div key={dept.id} className="group relative flex items-center pr-1" style={{ paddingLeft: 8 + depth * 14 }}>
              <button
                type="button"
                onClick={() => onSelectDept(dept.id)}
                className={`flex h-8 min-w-0 flex-1 items-center gap-1 rounded-gx-sm px-1.5 text-left text-gx-13 ${
                  active ? "bg-gx-accent-bg font-medium text-gx-accent" : "text-gx-text-primary hover:bg-gx-row-hover"
                }`}
                title={dept.name}
              >
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); if (hasChildren) toggle(dept.id); }}
                  className="flex h-4 w-4 shrink-0 items-center justify-center text-gx-text-tertiary"
                >
                  {hasChildren ? (
                    <Icon name={isOpen ? "chevronDown" : "chevronRight"} size={12} />
                  ) : (
                    <span className="h-1 w-1 rounded-full bg-gx-text-hint" />
                  )}
                </span>
                <span className="truncate">{dept.name}</span>
                <span className="ml-auto shrink-0 text-gx-11 text-gx-text-hint">{dept.memberCount}</span>
              </button>
              {canManage && (
                <span className="relative shrink-0">
                  <IconButton
                    icon="more"
                    size={14}
                    label="部门操作"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={() => setMenuFor(menuFor === dept.id ? null : dept.id)}
                  />
                  <Popover open={menuFor === dept.id} onClose={() => setMenuFor(null)} align="right" width={170}>
                    <Menu width={170}>
                      <MenuItem icon="plus" label="新建子部门" onClick={() => { setMenuFor(null); setCreatingParent(dept.id); }} />
                      <MenuItem icon="edit" label="重命名" onClick={() => { setMenuFor(null); setRenaming(dept); }} />
                      <MenuItem icon="swap" label="移动到…" onClick={() => { setMenuFor(null); setMoving(dept); }} />
                      <MenuItem icon="trash" label="删除部门" danger onClick={() => { setMenuFor(null); setDeleting(dept); }} />
                    </Menu>
                  </Popover>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {creatingParent !== undefined && (
        <DeptNameModal
          title={creatingParent === "ROOT" ? "新建顶级部门" : "新建子部门"}
          initialName=""
          onClose={() => setCreatingParent(undefined)}
          submitting={m.createDept.isPending}
          onSubmit={async (name) => {
            try {
              await m.createDept.mutateAsync({
                name,
                parentId: creatingParent === "ROOT" ? null : (creatingParent as string),
              });
              toast("已创建部门", "success");
              setCreatingParent(undefined);
            } catch (e) {
              toast(errText(e, "创建失败"), "error");
            }
          }}
        />
      )}

      {renaming && (
        <DeptNameModal
          title="重命名部门"
          initialName={renaming.name}
          onClose={() => setRenaming(null)}
          submitting={m.updateDept.isPending}
          onSubmit={async (name) => {
            try {
              await m.updateDept.mutateAsync({ id: renaming.id, data: { name } });
              toast("已保存", "success");
              setRenaming(null);
            } catch (e) {
              toast(errText(e, "重命名失败"), "error");
            }
          }}
        />
      )}

      {moving && (
        <MoveDeptModal
          dept={moving}
          all={depts}
          onClose={() => setMoving(null)}
          submitting={m.updateDept.isPending}
          onSubmit={async (parentId) => {
            if (wouldFormCycle(depts, moving.id, parentId)) {
              toast("不能移动到自身或其子部门之下", "error");
              return;
            }
            try {
              await m.updateDept.mutateAsync({ id: moving.id, data: { parentId } });
              toast("已移动部门", "success");
              setMoving(null);
            } catch (e) {
              toast(errText(e, "移动失败"), "error");
            }
          }}
        />
      )}

      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={<span className="text-gx-danger">删除部门</span>}
          width={420}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)} disabled={m.removeDept.isPending}>取消</Button>
              <Button
                variant="danger"
                loading={m.removeDept.isPending}
                onClick={async () => {
                  try {
                    await m.removeDept.mutateAsync(deleting.id);
                    toast("已删除部门", "success");
                    if (selectedDeptId === deleting.id) onSelectDept(null);
                    setDeleting(null);
                  } catch (e) {
                    // 409：后端在 error 文案里给出子部门/成员数，直接展示引导先处理
                    toast(errText(e, "删除失败"), "error");
                  }
                }}
              >
                确认删除
              </Button>
            </>
          }
        >
          <p className="text-gx-13 text-gx-text-primary">
            确定删除部门「<span className="font-medium">{deleting.name}</span>」吗？
          </p>
          <p className="text-gx-12 text-gx-text-tertiary">
            若该部门下仍有子部门或成员，将无法删除并提示你先移动或移除。
          </p>
        </Modal>
      )}
    </div>
  );
}

/** 部门名输入 Modal（新建/改名共用）。 */
function DeptNameModal({
  title,
  initialName,
  onSubmit,
  onClose,
  submitting,
}: {
  title: string;
  initialName: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
  submitting: boolean;
}) {
  const [name, setName] = useState(initialName);
  const valid = name.trim().length > 0 && name.trim().length <= 60;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width={400}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={submitting}
            onClick={() => valid && onSubmit(name.trim())}
          >
            保存
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-gx-12 font-medium text-gx-text-secondary">部门名称</span>
        <Input
          autoFocus
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && valid) onSubmit(name.trim()); }}
          placeholder="不超过 60 字"
        />
      </label>
    </Modal>
  );
}

/** 移动部门 Modal：父下拉（含「无上级（顶级）」），前端先拦环。 */
function MoveDeptModal({
  dept,
  all,
  onSubmit,
  onClose,
  submitting,
}: {
  dept: DeptDTO;
  all: DeptDTO[];
  onSubmit: (parentId: string | null) => void;
  onClose: () => void;
  submitting: boolean;
}) {
  // 可选父：排除自身与全部子孙（会成环）。
  const candidates = useMemo(() => movableParentCandidates(all, dept.id), [all, dept.id]);
  const [parentId, setParentId] = useState<string>(dept.parentId ?? "");
  const isCycle = wouldFormCycle(all, dept.id, parentId || null);

  return (
    <Modal
      open
      onClose={onClose}
      title={`移动「${dept.name}」`}
      width={400}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>取消</Button>
          <Button
            variant="primary"
            disabled={isCycle}
            loading={submitting}
            onClick={() => onSubmit(parentId || null)}
          >
            移动
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1.5">
        <span className="text-gx-12 font-medium text-gx-text-secondary">上级部门</span>
        <select
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
          className="h-8 w-full rounded-gx-md border border-gx-border bg-gx-surface px-2 text-gx-13 text-gx-text-primary"
        >
          <option value="">无上级（顶级部门）</option>
          {candidates.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        {isCycle && (
          <span className="text-gx-12 text-gx-danger">不能移动到自身或其子部门之下（会形成环）。</span>
        )}
      </label>
    </Modal>
  );
}
