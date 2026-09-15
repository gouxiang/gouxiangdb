// M4 DocAclModal 的企业权限引擎同表视图（门控 authzManage=true 时由 DocAclModal 切到此视图）。
// 旧 viewer/commenter/editor 三档 ↔ 七动作：
//   viewer=[r]，commenter=[r,comment]，editor=[r,c,u,d,comment]；
// 经统一 GET/PUT /nodes/:id/policies 读写（后端同事务反写 kb_doc_acls）。
// 部门/角色授予/非标动作组合无三档可映射：只读标"仅企业权限引擎生效"，不伪造档位、不回旧弹窗。
import { useEffect, useMemo, useState } from "react";
import type { NavNodeDTO, ResourceAction } from "@gx/shared-types";
import { Button, Spinner, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useNodePolicies, useSavePolicies } from "./authz-hooks";
import { SubjectPicker, type PickedSubject } from "./SubjectPicker";
import { buildPolicyWrite, toEditableRows, type EditableRow } from "./lib/policy-model";

type DocRole = "viewer" | "commenter" | "editor";

const ROLE_ACTIONS: Record<DocRole, ResourceAction[]> = {
  viewer: ["r"],
  commenter: ["r", "comment"],
  editor: ["r", "c", "u", "d", "comment"],
};
const ROLE_LABEL: Record<DocRole, string> = {
  editor: "可编辑",
  commenter: "可评论",
  viewer: "仅查看",
};
/** 动作集 → 三档；非标准集返 null（不可在旧档表达）。 */
function roleOfActions(actions: readonly ResourceAction[]): DocRole | null {
  const key = [...actions].sort().join(",");
  if (key === "r") return "viewer";
  if (key === "comment,r") return "commenter";
  if (key === "c,comment,d,r,u") return "editor";
  return null;
}

export function DocPolicyView({ node }: { node: NavNodeDTO }) {
  const policies = useNodePolicies(node.id);
  const save = useSavePolicies(node.id);
  const [rows, setRows] = useState<EditableRow[]>(() =>
    policies.view ? toEditableRows(policies.view.direct) : [],
  );

  useEffect(() => {
    if (policies.view) {
      setRows(toEditableRows(policies.view.direct));
    }
  }, [policies.view]);

  // 仅用户行参与三档视图；dept/role 行只作只读提示。
  const userRows = rows.filter((r) => !r.removed && r.subjectType === "user");
  const otherRows = rows.filter((r) => !r.removed && r.subjectType !== "user");
  const keys = useMemo(
    () => new Set(rows.filter((r) => !r.removed).map((r) => `${r.subjectType}:${r.subjectId}`)),
    [rows],
  );

  const setRole = (r: EditableRow, role: DocRole | null) => {
    if (role === null) {
      setRows((prev) => prev.map((x) => (x === r ? { ...x, actions: [] } : x)));
      return;
    }
    setRows((prev) => prev.map((x) => (x === r ? { ...x, actions: [...ROLE_ACTIONS[role]] } : x)));
  };

  const addUser = (s: PickedSubject) => {
    if (s.subjectType !== "user") return;
    setRows((prev) => [
      ...prev,
      {
        subjectType: "user",
        subjectId: s.subjectId,
        actions: ["r"],
        fieldMask: null,
        original: {
          id: "",
          subjectType: "user",
          subjectId: s.subjectId,
          subjectName: s.subjectName,
          actions: ["r"],
          fieldMask: null,
          reason: "policy:v1",
          createdAt: "",
        },
      },
    ]);
    // 新增行默认 actions=[r] 即 viewer，角色由动作集派生，无需额外草稿。
  };

  const write = buildPolicyWrite(rows);
  const onSave = () => {
    if (!write) {
      toast("没有待保存的改动", "info");
      return;
    }
    save.mutate(write);
  };

  if (policies.isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner size={18} />
      </div>
    );
  }
  if (policies.isError || !policies.view) {
    return <div className="px-3 py-8 text-center text-gx-12 text-gx-text-hint">无权管理该文档权限，或加载失败。</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-gx-12 text-gx-text-hint">
        成员权限与知识库角色叠加、取较高者；保存后同时同步到原文档独立权限。
      </p>

      <SubjectPicker
        exclude={keys}
        onPick={(s) => {
          if (s.subjectType === "user") addUser(s);
          else toast("部门/角色授予请在「权限管理」面板中配置", "info");
        }}
      />

      <div className="flex flex-col gap-1">
        {userRows.map((r) => {
          const role = roleOfActions(r.actions);
          const standard = role !== null;
          return (
            <div
              key={r.subjectId}
              className="flex items-center gap-2 rounded-gx-md border border-gx-separator px-2.5 py-1.5"
            >
              <Icon name="keyRound" size={13} className="shrink-0 text-gx-text-hint" />
              <span className="min-w-0 flex-1 truncate text-gx-13 text-gx-text-primary">
                {r.original?.subjectName ?? r.subjectId}
              </span>
              {standard ? (
                <select
                  value={role}
                  onChange={(e) => setRole(r, e.target.value as DocRole)}
                  className="rounded-gx-sm border border-gx-separator bg-gx-surface px-1.5 py-1 text-gx-12 text-gx-text-primary"
                >
                  <option value="editor">{ROLE_LABEL.editor}</option>
                  <option value="commenter">{ROLE_LABEL.commenter}</option>
                  <option value="viewer">{ROLE_LABEL.viewer}</option>
                </select>
              ) : (
                <span className="rounded-gx-pill bg-gx-row-hover px-1.5 py-0.5 text-gx-11 text-gx-text-hint">
                  仅企业权限引擎生效
                </span>
              )}
              <button
                type="button"
                onClick={() => setRole(r, null)}
                title="撤销独立权限"
                className="rounded p-1 text-gx-text-hint hover:bg-gx-danger-bg hover:text-gx-danger"
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          );
        })}
        {otherRows.map((r) => (
          <div key={`${r.subjectType}:${r.subjectId}`} className="flex items-center gap-2 rounded-gx-md bg-gx-row-hover px-2.5 py-1.5">
            <Icon name="shield" size={13} className="shrink-0 text-gx-text-hint" />
            <span className="min-w-0 flex-1 truncate text-gx-12 text-gx-text-secondary">
              {r.subjectType === "dept" ? "部门" : "角色"} {r.original?.subjectName ?? r.subjectId}
            </span>
            <span className="shrink-0 font-mono text-gx-11 text-gx-text-hint">{r.actions.join(" ")}</span>
            <span className="shrink-0 text-gx-11 text-gx-text-hint">仅企业权限引擎生效</span>
          </div>
        ))}
        {userRows.length === 0 && otherRows.length === 0 && (
          <div className="rounded-gx-md border border-dashed border-gx-separator px-3 py-6 text-center text-gx-12 text-gx-text-hint">
            暂无独立授权成员
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <Button variant="primary" size="sm" disabled={!write || save.isPending} loading={save.isPending} onClick={onSave}>
          保存权限
        </Button>
      </div>
    </div>
  );
}
