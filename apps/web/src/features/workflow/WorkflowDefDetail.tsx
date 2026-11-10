// 工作流定义详情主体（#1318 刀 C3-a2-i）：只读回显 + 按 status 门控的发布/手动触发（真接线，无死按钮）。
//
// 数据只走 useWorkflowDef / usePublishWorkflowDef / useTriggerWorkflowDef（禁裸 fetch，retry:false）。
// graph 用 safeParseGraph 显式判别：坏图走降级卡绝不白屏；枚举一律走 workflow-labels 中文函数。
// 后端无 update/delete def 端点，故本组件不含编辑/删除；发布（draft）与触发（published）是仅有的写操作。
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Badge, Button, EmptyState, Spinner, toast } from "../../components/ui";
import { Icon } from "../../components/icons";
import {
  usePublishWorkflowDef,
  useTriggerWorkflowDef,
  useWorkflowDef,
} from "./workflow-hooks";
import {
  workflowDefStatusLabel,
  workflowTriggerTypeLabel,
} from "./lib/workflow-labels";
import { normalizeWorkflowError, workflowErrorText } from "./lib/workflow-error";
import { safeParseGraph } from "./lib/workflow-graph";
import { WorkflowGraphReadonly } from "./WorkflowGraphReadonly";
import { WorkflowPublishDialog } from "./WorkflowPublishDialog";

/** ISO 时间切片到分钟，不引入日期库。 */
function fmtTs(raw: string): string {
  return raw.replace("T", " ").slice(0, 16);
}

function DetailError({ defId, error, onRetry }: { defId: string; error: unknown; onRetry: () => void }) {
  const info = normalizeWorkflowError(error);
  const notFound = info.code === "WORKFLOW_DEF_NOT_FOUND" || info.status === 404;
  return (
    <div className="flex flex-col gap-4">
      <BackLink />
      {notFound ? (
        <EmptyState
          icon="workflow"
          title="流程定义不存在或已被删除"
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
      <p className="m-0 font-mono text-gx-11 text-gx-text-hint">编号：{defId}</p>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/workflow"
      className="inline-flex w-fit items-center gap-1 text-gx-12 text-gx-text-secondary hover:text-gx-text-primary"
    >
      <Icon name="chevronLeft" size={14} />
      返回列表
    </Link>
  );
}

/** 按 def.status 门控的操作区：draft→发布、published→手动触发、disabled→中性提示（无可点按钮）。 */
function StatusActions({ defId, status, name }: { defId: string; status: string; name: string }) {
  const [publishOpen, setPublishOpen] = useState(false);
  const publish = usePublishWorkflowDef();
  const trigger = useTriggerWorkflowDef();

  if (status === "disabled") {
    return (
      <p className="m-0 rounded-gx-lg border border-gx-separator bg-gx-bg px-3 py-2 text-gx-12 text-gx-text-tertiary">
        该流程已停用，暂不可触发。
      </p>
    );
  }

  if (status === "published") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          loading={trigger.isPending}
          onClick={() =>
            trigger.mutate(
              { id: defId },
              {
                onSuccess: (r) => toast(`已触发，运行编号 ${r.id}`, "success"),
                onError: (e) => toast(workflowErrorText(normalizeWorkflowError(e)), "error"),
              },
            )
          }
        >
          手动触发
        </Button>
        <Link
          to={`/workflow/runs?defId=${encodeURIComponent(defId)}`}
          className="text-gx-12 text-gx-accent hover:underline"
        >
          查看运行记录
        </Link>
      </div>
    );
  }

  // draft（其余状态落到此分支也只给发布，后端会以 409 权威收口）。
  return (
    <>
      <Button variant="primary" icon="check" onClick={() => setPublishOpen(true)}>
        发布
      </Button>
      <WorkflowPublishDialog
        open={publishOpen}
        defName={name}
        busy={publish.isPending}
        onClose={() => setPublishOpen(false)}
        onConfirm={() =>
          publish.mutate(defId, {
            onSuccess: () => {
              setPublishOpen(false);
              toast("流程已发布", "success");
            },
            onError: (e) => {
              setPublishOpen(false);
              toast(workflowErrorText(normalizeWorkflowError(e)), "error");
            },
          })
        }
      />
    </>
  );
}

export function WorkflowDefDetail() {
  const { defId } = useParams();
  const defQ = useWorkflowDef(defId);

  if (!defId) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink />
        <EmptyState icon="alertCircle" title="缺少流程编号" description="链接不完整，无法定位流程定义。" />
      </div>
    );
  }
  if (defQ.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }
  if (defQ.isError || !defQ.data) {
    return <DetailError defId={defId} error={defQ.error} onRetry={() => defQ.refetch()} />;
  }

  const def = defQ.data;
  const parsed = safeParseGraph(def.graph);

  return (
    <div className="flex flex-col gap-5">
      <BackLink />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-gx-16 font-semibold text-gx-text-primary">{def.name}</h2>
          <Badge>{workflowDefStatusLabel(def.status)}</Badge>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-gx-12 text-gx-text-tertiary">
          <span>触发方式：{workflowTriggerTypeLabel(def.triggerType)}</span>
          <span className="font-mono">v{def.version}</span>
          <span>更新于 {fmtTs(def.updatedAt)}</span>
          <span>创建于 {fmtTs(def.createdAt)}</span>
        </div>
        {def.description && def.description.trim() !== "" && (
          <p className="m-0 text-gx-13 text-gx-text-secondary">{def.description}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-gx-13 font-semibold text-gx-text-primary">操作</h3>
        <StatusActions defId={def.id} status={def.status} name={def.name} />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-gx-13 font-semibold text-gx-text-primary">流程编排</h3>
        {parsed.ok ? (
          <WorkflowGraphReadonly graph={parsed.graph} />
        ) : (
          <div className="flex items-start gap-2 rounded-gx-lg border border-gx-separator bg-gx-bg p-3 text-gx-13 text-gx-text-secondary">
            <Icon name="alertCircle" size={16} className="mt-0.5 shrink-0 text-gx-warning" />
            <span>流程图数据无法解析：{parsed.reason}</span>
          </div>
        )}
      </div>
    </div>
  );
}
