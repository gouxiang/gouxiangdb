// 工作流三态门控（无任何 React hook 的纯组件，可在 node 环境 renderToStaticMarkup 直测）。
//
// 只负责按 useWorkflowFlag 的探针结果分流，本身不发请求、不读 store：
//   - 探活中（isLoading）或探针抛非 off 错误尚未决（enabled===null）：中性 Spinner，不预判 on/off；
//   - 总门 off（enabled===false）：渲染「如何启用」自助指引卡 WorkflowDisabledState；
//   - 引擎 on（enabled===true）：渲染 children（具体页面血肉由刀 C3 承接）。
// 页面组件（WorkflowDefsPage / WorkflowRunsPage）只负责接 useWorkflowFlag 并把 flag 传进来。
import type { ReactNode } from "react";
import { Spinner } from "../../components/ui";
import type { WorkflowFlagState } from "./useWorkflowFlag";
import { WorkflowDisabledState } from "./WorkflowDisabledState";

export interface WorkflowGateProps {
  flag: WorkflowFlagState;
  children: ReactNode;
}

export function WorkflowGate({ flag, children }: WorkflowGateProps) {
  if (flag.isLoading || flag.enabled === null) {
    return (
      <div
        data-gx-workflow-loading="true"
        className="flex h-full items-center justify-center"
      >
        <Spinner size={20} />
      </div>
    );
  }
  if (flag.enabled === false) {
    return <WorkflowDisabledState />;
  }
  return <>{children}</>;
}
