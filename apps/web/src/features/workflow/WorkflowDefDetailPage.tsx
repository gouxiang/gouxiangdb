// 工作流「流程定义详情」路由壳（/workflow/def/:defId，#1318 刀 C3-a2-i）。
//
// 与 WorkflowDefsPage 同构：页面组件只接 useWorkflowFlag 探针、把结果交给无 hooks 的 WorkflowGate 分流
// （探活中 Spinner / off 启用指引卡 / on 渲染详情主体）。useParams 与数据查询都下沉到 WorkflowDefDetail，
// 保证本壳保持轻量且满足 shell 护栏（含 useWorkflowFlag + export default function + ≤300 行）。
import { useWorkflowFlag } from "./useWorkflowFlag";
import { WorkflowGate } from "./WorkflowGate";
import { WorkflowDefDetail } from "./WorkflowDefDetail";

export default function WorkflowDefDetailPage() {
  const flag = useWorkflowFlag();
  return (
    <div className="flex h-full min-h-0 flex-col bg-gx-surface">
      <header className="shrink-0 border-b border-gx-hairline px-gx-xl py-gx-sm">
        <h1 className="m-0 text-gx-16 font-semibold text-gx-text-primary">流程详情</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-gx-xl py-gx-lg">
        <WorkflowGate flag={flag}>
          <WorkflowDefDetail />
        </WorkflowGate>
      </div>
    </div>
  );
}
