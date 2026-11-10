// 工作流运行详情主体（#1321 刀 C3-b2）：运行只读回显 + 失败警示 + 审批单列表与裁决入口。
//
// 数据只走 useWorkflowRun（禁裸 fetch，retry:false），返回 { run, approvals }；审批单后端已按 createdAt asc
// 排序，前端不重排。枚举一律走 workflow-labels 中文函数不手写字面量；可空列统一回落「-」杜绝 undefined。
// 仅 pending 审批单挂 ApprovalDecisionPanel，已裁决单只回显审批人/意见/时间；无 runs 写端点，本组件无删除按钮。
import { Link, useParams } from "react-router-dom";
import { Badge, Button, EmptyState, Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { WorkflowApprovalDTO } from "@gx/shared-types";
import { useWorkflowRun } from "./workflow-hooks";
import {
  workflowApprovalStatusLabel,
  workflowRunStatusLabel,
  workflowTriggerTypeLabel,
} from "./lib/workflow-labels";
import { normalizeWorkflowError, workflowErrorText } from "./lib/workflow-error";
import { ApprovalDecisionPanel } from "./ApprovalDecisionPanel";

/** ISO 时间切片到分钟（2026-09-20T10:15:00.000Z → 2026-09-20 10:15）；可空时间先回落「-」再切。 */
function fmtTs(raw: string | null | undefined): string {
  return raw ? raw.replace("T", " ").slice(0, 16) : "-";
}

/** 可空文本统一回落「-」，杜绝渲染空白/undefined。 */
function orDash(value: string | null | undefined): string {
  return value && value.trim() !== "" ? value : "-";
}

function defHref(id: string): string {
  return `/workflow/def/${encodeURIComponent(id)}`;
}

function BackLink() {
  return (
    <Link
      to="/workflow/runs"
      className="inline-flex w-fit items-center gap-1 text-gx-12 text-gx-text-secondary hover:text-gx-text-primary"
    >
      <Icon name="chevronLeft" size={14} />
      返回运行记录
    </Link>
  );
}

function DetailError({ runId, error, onRetry }: { runId: string; error: unknown; onRetry: () => void }) {
  const info = normalizeWorkflowError(error);
  const notFound = info.code === "WORKFLOW_RUN_NOT_FOUND" || info.status === 404;
  return (
    <div className="flex flex-col gap-4">
      <BackLink />
      {notFound ? (
        <EmptyState
          icon="workflow"
          title="运行记录不存在或已被删除"
          description="它可能已被移除，或链接中的编号有误。"
        />
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-gx-lg border border-gx-separator bg-gx-bg px-6 py-12 text-center">
          <Icon name="alertCircle" size={22} className="text-gx-warning" />
          <p className="m-0 text-gx-13 text-gx-text-secondary">{workflowErrorText(info)}</p>
          <Button variant="ghost" size="sm" icon="refresh" onClick={onRetry}>
            重试
          </Button>
        </div>
      )}
      <p className="m-0 font-mono text-gx-11 text-gx-text-hint">编号：{runId}</p>
    </div>
  );
}

/** 单张审批单卡片：pending 挂裁决面板，已裁决只回显结果（不重复给操作入口）。 */
function ApprovalCard({ approval }: { approval: WorkflowApprovalDTO }) {
  return (
    <div className="flex flex-col gap-2 rounded-gx-lg border border-gx-border p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-gx-12 text-gx-text-tertiary">
        <Badge>{workflowApprovalStatusLabel(approval.status)}</Badge>
        <span className="font-mono text-gx-text-secondary">节点 {approval.nodeId}</span>
        <span>提交于 {fmtTs(approval.createdAt)}</span>
      </div>
      {approval.status === "pending" ? (
        <ApprovalDecisionPanel approval={approval} />
      ) : (
        <div className="flex flex-col gap-1 text-gx-12 text-gx-text-tertiary">
          <span>
            审批人：<span className="font-mono text-gx-text-secondary">{orDash(approval.approverId)}</span>
          </span>
          <span>审批意见：{orDash(approval.comment)}</span>
          <span>裁决时间：{fmtTs(approval.decidedAt)}</span>
        </div>
      )}
    </div>
  );
}

export function WorkflowRunDetail() {
  const { runId } = useParams();
  const runQ = useWorkflowRun(runId);

  if (!runId) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <EmptyState icon="alertCircle" title="缺少运行编号" description="链接不完整，无法定位运行记录。" />
      </div>
    );
  }
  if (runQ.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }
  if (runQ.isError || !runQ.data) {
    return <DetailError runId={runId} error={runQ.error} onRetry={() => runQ.refetch()} />;
  }

  const { run, approvals } = runQ.data;
  const hasError = run.error !== null && run.error.trim() !== "";

  return (
    <div className="flex flex-col gap-5">
      <BackLink />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 font-mono text-gx-16 font-semibold text-gx-text-primary">{run.id}</h2>
          <Badge>{workflowRunStatusLabel(run.status)}</Badge>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-gx-12 text-gx-text-tertiary">
          <span>触发方式：{workflowTriggerTypeLabel(run.triggerType)}</span>
          <span className="font-mono">当前节点：{orDash(run.currentNodeId)}</span>
          <span>创建于 {fmtTs(run.createdAt)}</span>
          <span>开始于 {fmtTs(run.startedAt)}</span>
          <span>结束于 {fmtTs(run.finishedAt)}</span>
        </div>
        <Link to={defHref(run.defId)} className="w-fit text-gx-12 text-gx-accent hover:underline">
          所属流程：<span className="font-mono">{run.defId}</span>
        </Link>
      </div>

      {hasError && (
        <div
          data-gx-run-error="true"
          className="flex items-start gap-2 rounded-gx-lg border border-gx-separator bg-gx-bg p-3 text-gx-13 text-gx-text-secondary"
        >
          <Icon name="alertCircle" size={16} className="mt-0.5 shrink-0 text-gx-danger" />
          <span className="break-words" title={run.error ?? undefined}>
            {run.error}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-gx-13 font-semibold text-gx-text-primary">审批单（{approvals.length}）</h3>
        {approvals.length === 0 ? (
          <p className="m-0 text-gx-12 text-gx-text-tertiary">该运行暂无审批单</p>
        ) : (
          <div className="flex flex-col gap-2">
            {approvals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
