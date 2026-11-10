// 工作流新建编排主体（#1319 刀 C3-a2-ii）：基础表单 + DAG 画布 + 编辑期自检 + 一次性 create 后跳详情。
//
// 后端无 update/delete def 端点，graph 只能在 create 时一次性编排，故本组件是 POST /defs 的前置表单：
//   - 名称 trim 后非空才发请求，空名仅行内报错、绝不发请求；描述 trim 后为空则不带该可选字段；
//   - lintWorkflowGraph 是编辑期【友好提示】，只收集问题不 throw、不阻止提交（提交按钮绝不因 issues 禁用），
//     提交合法性以后端 validateWorkflowGraph 的 400 为权威收口；
//   - 成功（201 回 {id}）后 navigate 到只读详情页；失败走 normalizeWorkflowError/workflowErrorText + toast。
// 数据只走 useCreateWorkflowDef（禁裸 fetch）；枚举走冻结数组 + workflow-labels；样式只用 gx-* token。
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, FieldRow, Input, Select, Textarea, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import { WORKFLOW_TRIGGER_TYPES } from "@gx/shared-types";
import type { WorkflowTriggerType } from "@gx/shared-types";
import { useCreateWorkflowDef } from "./workflow-hooks";
import { workflowTriggerTypeLabel } from "./lib/workflow-labels";
import { normalizeWorkflowError, workflowErrorText } from "./lib/workflow-error";
import { createEmptyGraph, serializeGraph } from "./lib/workflow-edit";
import type { WorkflowDraft } from "./lib/workflow-edit";
import { lintWorkflowGraph } from "./lib/workflow-lint";
import { WorkflowGraphEditor } from "./WorkflowGraphEditor";

export function WorkflowComposer() {
  const navigate = useNavigate();
  const create = useCreateWorkflowDef();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [triggerType, setTriggerType] = useState<WorkflowTriggerType>("manual");
  const [graph, setGraph] = useState<WorkflowDraft>(() => createEmptyGraph());
  const [nameError, setNameError] = useState(false);

  // 编辑期自检：只提示不守门；空数组显中性「自检通过」，提交合法性仍以后端 400 为准。
  const issues = useMemo(() => lintWorkflowGraph(graph), [graph]);

  const onSubmit = (): void => {
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setNameError(true); // 行内报错，不发请求
      return;
    }
    const trimmedDesc = description.trim();
    create.mutate(
      {
        name: trimmedName,
        graph: serializeGraph(graph),
        triggerType,
        ...(trimmedDesc ? { description: trimmedDesc } : {}),
      },
      {
        onSuccess: (r) => navigate(`/workflow/def/${encodeURIComponent(r.id)}`),
        onError: (e) => toast(workflowErrorText(normalizeWorkflowError(e)), "error"),
      },
    );
  };

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Link
        to="/workflow"
        className="inline-flex w-fit items-center gap-1 text-gx-12 text-gx-text-secondary hover:text-gx-text-primary"
      >
        <Icon name="chevronLeft" size={14} />
        返回列表
      </Link>

      <section className="flex flex-col gap-4 rounded-gx-lg border border-gx-border bg-gx-surface p-4">
        <h2 className="m-0 text-gx-14 font-semibold text-gx-text-primary">基础信息</h2>
        <FieldRow label="流程名称">
          <Input
            value={name}
            maxLength={60}
            placeholder="给流程起个名字"
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(false);
            }}
          />
          {nameError && <p className="m-0 text-gx-12 text-gx-danger">请填写流程名称后再创建</p>}
        </FieldRow>
        <FieldRow label="描述（可选）">
          <Textarea
            rows={3}
            value={description}
            maxLength={500}
            placeholder="说明这个流程在什么场景下使用"
            onChange={(e) => setDescription(e.target.value)}
          />
        </FieldRow>
        <FieldRow label="触发方式">
          <Select
            value={triggerType}
            onChange={(e) => setTriggerType(e.target.value as WorkflowTriggerType)}
            options={WORKFLOW_TRIGGER_TYPES.map((v) => ({
              value: v,
              label: workflowTriggerTypeLabel(v),
            }))}
          />
        </FieldRow>
      </section>

      <section className="flex flex-col gap-4 rounded-gx-lg border border-gx-border bg-gx-surface p-4">
        <h2 className="m-0 text-gx-14 font-semibold text-gx-text-primary">流程编排</h2>
        <WorkflowGraphEditor graph={graph} onChange={setGraph} />
      </section>

      <section className="flex flex-col gap-2 rounded-gx-lg border border-gx-separator bg-gx-bg p-4">
        <h3 className="m-0 text-gx-13 font-semibold text-gx-text-primary">流程图自检</h3>
        {issues.length === 0 ? (
          <p className="m-0 flex items-center gap-1.5 text-gx-12 text-gx-text-secondary">
            <Icon name="check" size={14} className="shrink-0" />
            自检通过：当前未发现明显问题，最终合法性以后端校验为准。
          </p>
        ) : (
          <ul className="m-0 flex flex-col gap-1 p-0">
            {issues.map((issue, i) => (
              <li
                key={`${issue.code}-${i}`}
                className="flex items-start gap-1.5 text-gx-12 text-gx-danger"
              >
                <Icon name="alertCircle" size={14} className="mt-0.5 shrink-0" />
                <span>{issue.message}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-center gap-3">
        <Button type="button" variant="primary" icon="check" loading={create.isPending} onClick={onSubmit}>
          创建流程
        </Button>
        <Link to="/workflow" className="text-gx-13 text-gx-text-secondary hover:text-gx-text-primary">
          取消
        </Link>
      </div>
    </div>
  );
}
