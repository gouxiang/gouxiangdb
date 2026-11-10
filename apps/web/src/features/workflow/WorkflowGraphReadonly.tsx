// 工作流 DAG 只读回显（#1318 刀 C3-a2-i）：把已落库的 WorkflowGraph 渲染成节点卡片 + 连线清单。
//
// 纯展示组件：无 React hook、无 IO、无路由，输入一个完整 graph 即可在 node 环境 renderToStaticMarkup 直测。
// 与编辑器（#1319）刻意分离——本组件只读，不产生任何写操作；坏图的拦截在调用方用 safeParseGraph 完成，
// 进到这里的 graph 已保证 nodes/edges 形状合法，但仍对边做「两端节点存在」的防御性过滤（后端已校验，双保险）。
// 样式只用 gx-* token 与 rounded-gx-*，零 hex；类型标签一律走 workflow-labels，不手写枚举中文。
import type {
  ActionNodeConfig,
  ApprovalNodeConfig,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from "@gx/shared-types";
import { Badge } from "../../components/ui";
import { Icon } from "../../components/icons";
import { workflowNodeTypeLabel } from "./lib/workflow-labels";

/** 节点展示名：name 去空白后非空则用 name，否则回落 id（对齐 a1 nodeOptions 口径）。 */
function nodeLabel(node: WorkflowNode): string {
  const trimmed = node.name?.trim();
  return trimmed ? trimmed : node.id;
}

/** action 节点的补充说明：op + 目标表；config 为空形态（编辑期中间态）时不渲染该行。 */
function actionHint(node: WorkflowNode): string | null {
  const cfg = node.config as ActionNodeConfig | undefined;
  if (!cfg || typeof cfg.op !== "string" || typeof cfg.tableId !== "string" || cfg.tableId.trim() === "") {
    return null;
  }
  return `操作 ${cfg.op} · 表 ${cfg.tableId}`;
}

/** approval 节点的补充说明：有审批人显数量，空则任意有权者可审批。 */
function approvalHint(node: WorkflowNode): string {
  const cfg = node.config as ApprovalNodeConfig | undefined;
  const ids = cfg?.approverIds;
  const count = Array.isArray(ids) ? ids.length : 0;
  return count > 0 ? `审批人 ${count} 名` : "任意有权者可审批";
}

function NodeCard({ node }: { node: WorkflowNode }) {
  const hint =
    node.type === "action" ? actionHint(node) : node.type === "approval" ? approvalHint(node) : null;
  return (
    <li className="flex flex-col gap-1 rounded-gx-lg border border-gx-separator bg-gx-bg p-3">
      <div className="flex items-center gap-2">
        <Badge>{workflowNodeTypeLabel(node.type)}</Badge>
        <span className="truncate text-gx-13 font-medium text-gx-text-primary">{nodeLabel(node)}</span>
      </div>
      <span className="font-mono text-gx-11 text-gx-text-hint">{node.id}</span>
      {hint && <span className="text-gx-12 text-gx-text-secondary">{hint}</span>}
    </li>
  );
}

function EdgeRow({ edge }: { edge: WorkflowEdge }) {
  return (
    <li className="flex items-center gap-1.5 font-mono text-gx-12 text-gx-text-secondary">
      <Icon name="cornerDownRight" size={14} className="shrink-0 text-gx-text-hint" />
      <span className="text-gx-text-primary">{edge.from}</span>
      <span className="text-gx-text-hint">→</span>
      <span className="text-gx-text-primary">{edge.to}</span>
    </li>
  );
}

export function WorkflowGraphReadonly({ graph }: { graph: WorkflowGraph }) {
  const ids = new Set(graph.nodes.map((n) => n.id));
  // 防御：只渲染两端节点都存在的边，避免历史坏数据画出悬空连线。
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return (
    <section className="flex flex-col gap-4" data-gx-workflow-graph-readonly="true">
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-gx-13 font-semibold text-gx-text-primary">节点（{graph.nodes.length}）</h3>
        <ul className="m-0 flex flex-col gap-2 p-0">
          {graph.nodes.map((node) => (
            <NodeCard key={node.id} node={node} />
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-gx-13 font-semibold text-gx-text-primary">连线（{edges.length}）</h3>
        {edges.length === 0 ? (
          <p className="m-0 text-gx-12 text-gx-text-hint">该流程暂无连线，触发后仅执行入口节点。</p>
        ) : (
          <ul className="m-0 flex flex-col gap-1 p-0">
            {edges.map((edge, i) => (
              <EdgeRow key={`${edge.from}->${edge.to}-${i}`} edge={edge} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
