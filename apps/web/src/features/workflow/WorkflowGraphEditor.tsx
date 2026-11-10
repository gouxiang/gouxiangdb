// 工作流画布编辑容器（#1319 刀 C3-a2-ii）：节点增删/选中 + 挂载节点表单与连线编辑。
//
// 受控组件：graph 由父级 WorkflowComposer 持有，本组件只经 workflow-edit 纯函数产出新图后 onChange。
// selectedId 是纯交互态、不参与提交，故内聚在本组件（父级 props 只需 graph/onChange）。
// 纪律：trigger 由 createEmptyGraph 内置且后端要求恰好一个，故只允许添加 action/approval，
// 且唯一 trigger 节点不渲染删除入口；删除普通节点时 removeNode 级联清理引用它的边。
// 零裸 fetch、零 hex；图标只用 icons.tsx 已注册名；类型标签走 workflow-labels。
import { useState } from "react";
import { Badge, Button, IconButton } from "../../components/ui";
import type { WorkflowNode, WorkflowNodeType } from "@gx/shared-types";
import type { WorkflowDraft } from "./lib/workflow-edit";
import { addNode, removeNode, updateNode } from "./lib/workflow-edit";
import { workflowNodeTypeLabel } from "./lib/workflow-labels";
import { WorkflowNodeEditor } from "./WorkflowNodeEditor";
import { WorkflowEdgeEditor } from "./WorkflowEdgeEditor";

interface GraphEditorProps {
  graph: WorkflowDraft;
  onChange: (next: WorkflowDraft) => void;
}

/** 节点展示名：name 去空白非空则用 name，否则回落 id（对齐 nodeOptions / 只读组件口径）。 */
function nodeLabel(node: WorkflowNode): string {
  const trimmed = node.name?.trim();
  return trimmed ? trimmed : node.id;
}

/** 仅允许追加的节点种类：trigger 唯一内置，不在此列。 */
const ADDABLE: ReadonlyArray<Exclude<WorkflowNodeType, "trigger">> = ["action", "approval"];

export function WorkflowGraphEditor({ graph, onChange }: GraphEditorProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedNode = graph.nodes.find((n) => n.id === selectedId) ?? null;

  const onAdd = (type: Exclude<WorkflowNodeType, "trigger">): void => {
    const result = addNode(graph, { type });
    onChange(result.graph);
    setSelectedId(result.nodeId); // 新建即选中，便于立刻在右侧/下方配置
  };

  const onRemove = (id: string): void => {
    onChange(removeNode(graph, id));
    if (selectedId === id) setSelectedId(null);
  };

  const onPatch = (patch: Partial<Pick<WorkflowNode, "name" | "config">>): void => {
    if (selectedNode) onChange(updateNode(graph, selectedNode.id, patch));
  };

  return (
    <section data-gx-graph-editor="true" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-gx-12 font-medium text-gx-text-secondary">添加节点</span>
        {ADDABLE.map((type) => (
          <Button key={type} size="sm" icon="plus" onClick={() => onAdd(type)}>
            {`添加${workflowNodeTypeLabel(type)}`}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-gx-13 font-semibold text-gx-text-primary">
          节点（{graph.nodes.length}）
        </h3>
        <ul className="m-0 flex flex-col gap-2 p-0">
          {graph.nodes.map((node) => {
            const selected = node.id === selectedId;
            return (
              <li
                key={node.id}
                className={
                  selected
                    ? "flex items-center gap-2 rounded-gx-lg border border-gx-accent bg-gx-accent-bg px-2 py-1.5"
                    : "flex items-center gap-2 rounded-gx-lg border border-gx-separator bg-gx-bg px-2 py-1.5"
                }
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(node.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <Badge>{workflowNodeTypeLabel(node.type)}</Badge>
                  <span className="truncate text-gx-13 text-gx-text-primary">{nodeLabel(node)}</span>
                </button>
                {node.type !== "trigger" && (
                  <IconButton
                    icon="trash"
                    size={14}
                    danger
                    label="删除节点"
                    onClick={() => onRemove(node.id)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {selectedNode && (
        // key 绑定节点 id：切换选中时整体重挂，节点内 payload 本地文本按新节点重新初始化。
        <WorkflowNodeEditor key={selectedNode.id} node={selectedNode} onPatch={onPatch} />
      )}

      <WorkflowEdgeEditor graph={graph} onChange={onChange} />
    </section>
  );
}
