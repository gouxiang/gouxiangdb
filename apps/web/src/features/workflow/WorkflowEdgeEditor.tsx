// 工作流画布「连线」编辑区（#1319 刀 C3-a2-ii）：选起点/终点追加边，列出并删除现有边。
//
// 受控组件：graph 由父级持有，本组件只调 workflow-edit 纯函数（addEdge/removeEdge）后把新图上交。
// addEdge 对自环/重复边返回 ok:false（原引用），这里不写图、改 toast 提示；纯函数已保证不产生悬空边
// （下拉选项只来自当前节点）。零裸 fetch、零 hex；图标只用 icons.tsx 已注册名。
import { useState } from "react";
import { Button, FieldRow, IconButton, Select, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { WorkflowGraph } from "@gx/shared-types";
import { addEdge, nodeOptions, removeEdge } from "./lib/workflow-edit";

interface EdgeEditorProps {
  graph: WorkflowGraph;
  onChange: (next: WorkflowGraph) => void;
}

export function WorkflowEdgeEditor({ graph, onChange }: EdgeEditorProps) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const options = nodeOptions(graph);
  const selectOptions = [
    { value: "", label: "请选择节点", disabled: true },
    ...options,
  ];
  const canAdd = from !== "" && to !== "";

  const onAdd = (): void => {
    const result = addEdge(graph, from, to);
    if (!result.ok) {
      toast("不能添加自环或重复连线", "error");
      return;
    }
    onChange(result.graph);
    setFrom("");
    setTo("");
  };

  return (
    <section data-gx-edge-editor="true" className="flex flex-col gap-3">
      <h3 className="m-0 text-gx-13 font-semibold text-gx-text-primary">连线</h3>
      <div className="flex flex-wrap items-end gap-2">
        <FieldRow label="起点">
          <Select
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            options={selectOptions}
          />
        </FieldRow>
        <span className="pb-2 text-gx-text-hint" aria-hidden="true">
          →
        </span>
        <FieldRow label="终点">
          <Select value={to} onChange={(e) => setTo(e.target.value)} options={selectOptions} />
        </FieldRow>
        <Button size="sm" icon="plus" disabled={!canAdd} onClick={onAdd}>
          添加连线
        </Button>
      </div>
      {graph.edges.length === 0 ? (
        <p className="m-0 text-gx-12 text-gx-text-hint">
          还没有连线，可先保存仅含触发器的流程，后续再补节点间流向。
        </p>
      ) : (
        <ul className="m-0 flex flex-col gap-1 p-0">
          {graph.edges.map((edge, i) => (
            <li
              key={`${edge.from}->${edge.to}-${i}`}
              className="flex items-center gap-1.5 font-mono text-gx-12 text-gx-text-secondary"
            >
              <Icon name="cornerDownRight" size={14} className="shrink-0 text-gx-text-hint" />
              <span className="text-gx-text-primary">{edge.from}</span>
              <span className="text-gx-text-hint">→</span>
              <span className="text-gx-text-primary">{edge.to}</span>
              <IconButton
                icon="trash"
                size={14}
                label="删除连线"
                danger
                onClick={() => onChange(removeEdge(graph, edge.from, edge.to))}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
