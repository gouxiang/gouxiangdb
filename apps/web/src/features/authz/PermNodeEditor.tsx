// M4 权限面板右侧：选中节点的策略编辑（direct 可编辑 + ancestors cutoff 只读）。
// 可编辑 = 门控放行（authzManage）且本人 effective 含 manage_share（后端判定，非本地越权）。
import { useEffect, useMemo, useState } from "react";
import type {
  FieldMaskDTO,
  NavNodeDTO,
  PolicyAncestorSummaryDTO,
} from "@gx/shared-types";
import { Button, Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";
import { useNodePolicies, useSavePolicies, useEffective } from "./authz-hooks";
import { useAuthzCapability } from "./useAuthzCapability";
import { PolicyMatrixRow, AncestorSummary } from "./PolicyMatrix";
import { SubjectPicker, type PickedSubject } from "./SubjectPicker";
import { FieldMaskEditor } from "./FieldMaskEditor";
import { InheritanceToggle } from "./InheritanceToggle";
import {
  buildPolicyWrite,
  formatLegacyUnmappable,
  toEditableRows,
  type EditableRow,
} from "./lib/policy-model";

export function PermNodeEditor({ node }: { node: NavNodeDTO }) {
  const { canManage } = useAuthzCapability();
  const policies = useNodePolicies(node.id);
  const selfEffective = useEffective(canManage ? node.id : null);
  const save = useSavePolicies(node.id);

  // 惰性初值保证首帧/SSR 即按服务端 direct 渲染（父级以 node.id 作 key 切换节点会整体重挂）；
  // effect 仅处理同节点下 policyVersion 刷新后的重置。
  const [rows, setRows] = useState<EditableRow[]>(() =>
    policies.view ? toEditableRows(policies.view.direct) : [],
  );
  const [fieldsFor, setFieldsFor] = useState<EditableRow | null>(null);
  const [unmappableNote, setUnmappableNote] = useState<string[]>([]);

  useEffect(() => {
    if (policies.view) {
      setRows(toEditableRows(policies.view.direct));
      setUnmappableNote([]);
    }
  }, [policies.view]);

  // 本人是否持该节点 manage_share（后端 effective 判定；门控关则一律只读）。
  const canShare = !!selfEffective.view?.actions.includes("manage_share");
  const editable = canManage && canShare;

  const write = useMemo(() => buildPolicyWrite(rows), [rows]);
  const existingKeys = useMemo(
    () => new Set(rows.filter((r) => !r.removed).map((r) => `${r.subjectType}:${r.subjectId}`)),
    [rows],
  );

  const patchRow = (next: EditableRow) =>
    setRows((prev) => prev.map((r) => (r.subjectType === next.subjectType && r.subjectId === next.subjectId ? next : r)));
  const removeRow = (target: EditableRow) =>
    setRows((prev) => prev.map((r) => (r === target ? { ...r, removed: true } : r)));
  const addSubject = (s: PickedSubject) =>
    setRows((prev) => [
      ...prev,
      {
        subjectType: s.subjectType,
        subjectId: s.subjectId,
        actions: [],
        fieldMask: null,
        original: {
          id: "",
          subjectType: s.subjectType,
          subjectId: s.subjectId,
          subjectName: s.subjectName,
          actions: [],
          fieldMask: null,
          reason: "policy:v1",
          createdAt: "",
        },
      },
    ]);

  const onSave = () => {
    if (!write) return;
    save.mutate(write, {
      onSuccess: (res) => setUnmappableNote(formatLegacyUnmappable(res.legacyUnmappable)),
    });
  };

  if (policies.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner size={18} />
      </div>
    );
  }
  if (policies.isError || !policies.view) {
    return (
      <div className="px-3 py-10 text-center text-gx-12 text-gx-text-hint">
        无权查看该节点权限，或权限数据加载失败。
      </div>
    );
  }

  const view = policies.view;
  const isTable = node.kind === "table";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-gx-14 font-medium text-gx-text-primary">{node.name}</div>
          <div className="text-gx-12 text-gx-text-hint">{kindLabel(node.kind)} · {node.resourceType ?? "容器"}</div>
        </div>
        <InheritanceToggle node={node} inheritAncestors={view.inheritAncestors} editable={editable} />
      </div>

      {!editable && (
        <div className="flex items-center gap-1.5 rounded-gx-md bg-gx-row-hover px-2.5 py-1.5 text-gx-12 text-gx-text-hint">
          <Icon name="lock" size={13} className="shrink-0" />
          {canManage ? "你没有该节点的分享管理权限，当前为只读视图。" : "权限编辑未在本环境开放，当前为只读视图。"}
        </div>
      )}

      {editable && (
        <>
          <SubjectPicker exclude={existingKeys} onPick={addSubject} />
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" disabled={!write || save.isPending} loading={save.isPending} onClick={onSave}>
              保存权限
            </Button>
            {!write && <span className="text-gx-12 text-gx-text-hint">有改动后可保存（整单提交，任一不合法全部不生效）</span>}
          </div>
        </>
      )}

      {unmappableNote.length > 0 && (
        <div className="rounded-gx-md border border-gx-separator px-2.5 py-2">
          <div className="mb-1 text-gx-12 font-medium text-gx-text-secondary">以下授权已在企业权限引擎生效，但旧权限表无对应档：</div>
          <ul className="flex flex-col gap-0.5">
            {unmappableNote.map((line, i) => (
              <li key={i} className="text-gx-12 text-gx-text-hint">{line}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <SectionTitle>本节点直接授权</SectionTitle>
        {rows.filter((r) => !r.removed).length === 0 ? (
          <div className="rounded-gx-md border border-dashed border-gx-separator px-2.5 py-6 text-center text-gx-12 text-gx-text-hint">
            暂无直接授权，访问仅来自上级继承。
          </div>
        ) : (
          rows
            .filter((r) => !r.removed)
            .map((r) => (
              <PolicyMatrixRow
                key={`${r.subjectType}:${r.subjectId}`}
                row={r}
                nodeKind={node.kind}
                readonly={!editable}
                onChange={patchRow}
                onRemove={() => removeRow(r)}
                onEditFields={isTable ? () => setFieldsFor(r) : undefined}
              />
            ))
        )}
      </div>

      <AncestorSection groups={view.ancestors} />

      {fieldsFor && (
        <FieldMaskEditor
          open
          key={`${fieldsFor.subjectType}:${fieldsFor.subjectId}`}
          tableId={node.resourceId ?? ""}
          subjectName={fieldsFor.original?.subjectName ?? fieldsFor.subjectId}
          initial={fieldsFor.fieldMask}
          onClose={() => setFieldsFor(null)}
          onSave={(mask: FieldMaskDTO | null) => {
            patchRow({ ...fieldsFor, fieldMask: mask });
            setFieldsFor(null);
          }}
        />
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-gx-11 font-medium text-gx-text-hint">{children}</div>;
}

function AncestorSection({ groups }: { groups: PolicyAncestorSummaryDTO[] }) {
  const total = groups.reduce((n, g) => n + g.policies.length, 0);
  if (total === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <SectionTitle>从上级继承（只读）</SectionTitle>
      {groups.map((g) =>
        g.policies.map((p, i) => (
          <AncestorSummary
            key={`${g.nodeId}:${p.subjectType}:${p.subjectId}:${i}`}
            nodeName={g.nodeName}
            subjectName={p.subjectName}
            subjectType={p.subjectType}
            actions={p.actions}
          />
        )),
      )}
    </div>
  );
}

function kindLabel(kind: NavNodeDTO["kind"]): string {
  const map: Record<string, string> = {
    base: "多维表库",
    table: "数据表",
    kb: "知识库",
    doc: "文档",
    canvas: "画布",
    view: "视图",
    group: "分组",
  };
  return map[kind] ?? kind;
}
