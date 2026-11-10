// 工作流「新建流程」路由壳（/workflow/new，#1319 刀 C3-a2-ii）。
//
// 严格同构 WorkflowDefDetailPage：页面组件只接 useWorkflowFlag 探针、把结果交给无 hooks 的 WorkflowGate
// 分流（探活中 Spinner / off 启用指引卡 / on 渲染编排主体 WorkflowComposer）。编排状态与一次性 create
// 都下沉到 WorkflowComposer，保证本壳轻量并满足 shell 护栏（含 useWorkflowFlag + export default function
// + ≤300 行）。引擎总门默认 off，门控在本壳挡住，组件本身按 on 态编写。
import { useWorkflowFlag } from "./useWorkflowFlag";
import { WorkflowGate } from "./WorkflowGate";
import { WorkflowComposer } from "./WorkflowComposer";

export default function WorkflowComposerPage() {
  const flag = useWorkflowFlag();
  return (
    <div className="flex h-full min-h-0 flex-col bg-gx-surface">
      <header className="shrink-0 border-b border-gx-hairline px-gx-xl py-gx-sm">
        <h1 className="m-0 text-gx-16 font-semibold text-gx-text-primary">新建流程</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-gx-xl py-gx-lg">
        <WorkflowGate flag={flag}>
          <WorkflowComposer />
        </WorkflowGate>
      </div>
    </div>
  );
}
