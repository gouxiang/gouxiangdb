// 工作流「运行记录」路由壳（/workflow/runs）：门控壳 + 运行记录列表血肉（刀 C3-b1 通电）。
//
// 页面组件只做两件事：接 useWorkflowFlag 探针、把结果交给无 hooks 的 WorkflowGate 分流。
//   - 探活中/未决：中性 Spinner；off：WorkflowDisabledState 启用指引卡；
//   - on：渲染 WorkflowRunList（分页 + defId 过滤 + 状态徽章 + 进详情，读路径闭环）。
import { useWorkflowFlag } from "./useWorkflowFlag";
import { WorkflowGate } from "./WorkflowGate";
import { WorkflowRunList } from "./WorkflowRunList";

export default function WorkflowRunsPage() {
  const flag = useWorkflowFlag();
  return (
    <div className="flex h-full min-h-0 flex-col bg-gx-surface">
      <header className="shrink-0 border-b border-gx-hairline px-gx-xl py-gx-sm">
        <h1 className="m-0 text-gx-16 font-semibold text-gx-text-primary">运行记录</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-gx-xl py-gx-lg">
        <WorkflowGate flag={flag}>
          <WorkflowRunList />
        </WorkflowGate>
      </div>
    </div>
  );
}
