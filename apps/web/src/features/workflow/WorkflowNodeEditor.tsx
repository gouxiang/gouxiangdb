// 工作流画布「单个选中节点」配置表单（#1319 刀 C3-a2-ii）：按 node.type 渲染 name + 判别联合 config。
//
// 受控组件：自身不持有 graph，只把不可变补丁通过 onPatch 上交（父级用 updateNode 合并）。
//   - trigger：TriggerNodeConfig=Record<string,never>，无可编辑项，只给说明；
//   - action：op/tableId/payload（JSON 文本本地持有，parse 成功才写回，非法仅行内提示、保留文本不阻断），
//     op==="update" 时再要 recordId；
//   - approval：approverIds 逗号分隔输入，空数组即「任意有权者可审批」。
// 父级以 key={node.id} 挂载本组件，切换节点时整体重挂，payload 本地文本随之按新节点初始化，无需 effect 同步。
// 样式只用 gx-* token；零裸 fetch、零 hex；枚举走冻结数组，不手写取值。
import { useState } from "react";
import { FieldRow, Input, Select, Textarea } from "../../components/ui";
import { WORKFLOW_ACTION_OPS } from "@gx/shared-types";
import type {
  ActionNodeConfig,
  ApprovalNodeConfig,
  WorkflowActionOp,
  WorkflowNode,
} from "@gx/shared-types";

type NodePatch = Partial<Pick<WorkflowNode, "name" | "config">>;

interface NodeEditorProps {
  node: WorkflowNode;
  onPatch: (patch: NodePatch) => void;
}

/** action 节点 config 表单（payload 非法时只提示不写回，避免把坏 JSON 灌进草稿）。 */
function ActionFields({ node, onPatch }: NodeEditorProps) {
  const cfg = (node.config ?? {}) as ActionNodeConfig;
  const [payloadText, setPayloadText] = useState(() => JSON.stringify(cfg.payload ?? {}, null, 2));
  const [payloadError, setPayloadError] = useState<string | null>(null);

  const merge = (next: Partial<ActionNodeConfig>): void => {
    onPatch({ config: { ...cfg, ...next } as ActionNodeConfig });
  };

  const onPayload = (text: string): void => {
    setPayloadText(text);
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setPayloadError("payload 必须是 JSON 对象");
        return;
      }
      setPayloadError(null);
      merge({ payload: parsed as Record<string, unknown> });
    } catch {
      // 保留用户文本但不写回 config：后端校验以最终合法 payload 为准，编辑期允许中间非法态。
      setPayloadError("payload 不是合法 JSON，已保留文本但暂不保存");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <FieldRow label="操作类型">
        <Select
          value={cfg.op ?? ""}
          onChange={(e) => merge({ op: e.target.value as WorkflowActionOp })}
          options={[
            { value: "", label: "请选择操作", disabled: true },
            ...WORKFLOW_ACTION_OPS.map((op) => ({ value: op, label: op })),
          ]}
        />
      </FieldRow>
      <FieldRow label="目标表 ID">
        <Input
          value={cfg.tableId ?? ""}
          onChange={(e) => merge({ tableId: e.target.value })}
          placeholder="tbl_..."
        />
      </FieldRow>
      <FieldRow label="写入字段（JSON 对象）">
        <Textarea rows={5} value={payloadText} onChange={(e) => onPayload(e.target.value)} />
      </FieldRow>
      {payloadError && <p className="m-0 text-gx-12 text-gx-danger">{payloadError}</p>}
      {cfg.op === "update" && (
        <FieldRow label="目标记录 ID（update 操作必填）">
          <Input
            value={cfg.recordId ?? ""}
            onChange={(e) => merge({ recordId: e.target.value })}
            placeholder="rec_..."
          />
        </FieldRow>
      )}
    </div>
  );
}

/** approval 节点 config：逗号分隔审批人，留空（空数组）表示任意有权者可审批。 */
function ApprovalFields({ node, onPatch }: NodeEditorProps) {
  const cfg = (node.config ?? {}) as ApprovalNodeConfig;
  const value = (cfg.approverIds ?? []).join(", ");
  const onApprovers = (text: string): void => {
    const approverIds = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onPatch({ config: { ...cfg, approverIds } });
  };
  return (
    <FieldRow label="审批人 ID（逗号分隔）" hint="留空表示任意有权者可审批">
      <Input value={value} onChange={(e) => onApprovers(e.target.value)} placeholder="u_1, u_2" />
    </FieldRow>
  );
}

export function WorkflowNodeEditor({ node, onPatch }: NodeEditorProps) {
  return (
    <section
      data-gx-node-editor={node.type}
      className="flex flex-col gap-3 rounded-gx-lg border border-gx-separator bg-gx-bg p-3"
    >
      <FieldRow label="节点名称">
        <Input
          value={node.name ?? ""}
          maxLength={60}
          placeholder="未命名节点"
          onChange={(e) => onPatch({ name: e.target.value })}
        />
      </FieldRow>
      {node.type === "trigger" && (
        <p className="m-0 text-gx-12 text-gx-text-hint">触发器由系统内置且唯一，无需额外配置。</p>
      )}
      {node.type === "action" && <ActionFields node={node} onPatch={onPatch} />}
      {node.type === "approval" && <ApprovalFields node={node} onPatch={onPatch} />}
    </section>
  );
}
