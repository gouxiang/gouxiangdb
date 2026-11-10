// 工作流「流程定义」路由壳（/workflow）：门控壳 + 定义列表血肉（刀 C3-a2-i 通电）。
//
// 页面组件只做两件事：接 useWorkflowFlag 探针、把结果交给无 hooks 的 WorkflowGate 分流。
//   - 探活中/未决：中性 Spinner；off：WorkflowDisabledState 启用指引卡；
//   - on：渲染 WorkflowDefList（分页列表四态，读路径闭环；新建/编排器在后续刀 #1319）。
import { useWorkflowFlag } from "./useWorkflowFlag";
import { WorkflowGate } from "./WorkflowGate";
import { WorkflowDefList } from "./WorkflowDefList";

export default function WorkflowDefsPage() {
  const flag = useWorkflowFlag();
  return (
    <div className="flex h-full min-h-0 flex-col bg-gx-surface">
      <header className="shrink-0 border-b border-gx-hairline px-gx-xl py-gx-sm">
        <h1 className="m-0 text-gx-16 font-semibold text-gx-text-primary">工作流</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-gx-xl py-gx-lg">
        <WorkflowGate flag={flag}>
          <WorkflowDefList />
        </WorkflowGate>
      </div>
    </div>
  );
}
