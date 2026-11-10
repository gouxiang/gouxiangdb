// 工作流「运行记录」分页列表（#1320 刀 C3-b1）：四态 + 手写表格 + page 基分页 + defId 过滤。
//
// 数据只走 useWorkflowRuns（禁裸 fetch，retry:false）；defId 来自 URL ?defId=（定义详情
// 「查看运行记录」跳入），过滤态顶部给筛选 chip + 清除（Link 回无参 /workflow/runs）。枚举一律走
// workflow-labels 中文函数不手写字面量；样式只用 gx-* token，Badge 不传 color 走默认灰。
// 后端没有 runs 的删除/停用端点，故本组件只有只读与进详情链接，不放任何写操作按钮。
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge, Button, EmptyState, Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { WorkflowRunDTO } from "@gx/shared-types";
import { useWorkflowRuns } from "./workflow-hooks";
import { workflowRunStatusLabel, workflowTriggerTypeLabel } from "./lib/workflow-labels";
import { normalizeWorkflowError, workflowErrorText } from "./lib/workflow-error";
import {
  WORKFLOW_DEFAULT_PAGE_SIZE, workflowPageState, prevPage, nextPage,
} from "./lib/workflow-paging";

/** ISO 时间切片到分钟（2026-09-20T10:15:00.000Z → 2026-09-20 10:15），不引入日期库。 */
function fmtTs(raw: string): string {
  return raw.replace("T", " ").slice(0, 16);
}

function runHref(id: string): string {
  return `/workflow/runs/${encodeURIComponent(id)}`;
}

function defHref(id: string): string {
  return `/workflow/def/${encodeURIComponent(id)}`;
}

/** 可空文本列统一回落「-」，杜绝渲染空白。 */
function orDash(value: string | null | undefined): string {
  return value && value.trim() !== "" ? value : "-";
}

/** defId 过滤态顶部 chip：说明当前只看某流程，并给回到全量列表的清除入口（Link，非写按钮）。 */
function FilterChip({ defId }: { defId: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-gx-border bg-gx-accent-bg px-2.5 py-1 text-gx-12 text-gx-text-secondary">
        <Icon name="filter" size={13} className="shrink-0 text-gx-accent" />
        <span className="shrink-0">仅看流程：</span>
        <span className="truncate font-mono text-gx-text-primary">{defId}</span>
      </span>
      <Link to="/workflow/runs" className="inline-flex h-7 items-center gap-1 rounded-gx-sm px-2 text-gx-12 text-gx-accent transition-colors duration-[120ms] hover:bg-gx-accent-bg">
        <Icon name="close" size={13} />
        清除
      </Link>
    </div>
  );
}

function WorkflowRunRow({ run }: { run: WorkflowRunDTO }) {
  const hasError = run.error !== null && run.error.trim() !== "";
  return (
    <div className="flex items-center gap-3 border-b border-gx-separator px-3 py-2.5 last:border-0">
      <span className="w-32 shrink-0">
        <Link to={runHref(run.id)} className="block truncate font-mono text-gx-12 text-gx-accent hover:underline">
          {run.id}
        </Link>
      </span>
      <span className="w-28 shrink-0">
        <Link to={defHref(run.defId)} className="block truncate font-mono text-gx-12 text-gx-text-secondary hover:underline">
          {run.defId}
        </Link>
      </span>
      <span className="flex w-24 shrink-0">
        <Badge>{workflowRunStatusLabel(run.status)}</Badge>
      </span>
      <span className="w-24 shrink-0 truncate text-gx-12 text-gx-text-secondary">
        {workflowTriggerTypeLabel(run.triggerType)}
      </span>
      <span className="w-24 shrink-0 truncate font-mono text-gx-12 text-gx-text-tertiary">
        {orDash(run.currentNodeId)}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-gx-12 ${hasError ? "text-gx-danger" : "text-gx-text-tertiary"}`}
        title={run.error ?? undefined}
      >
        {orDash(run.error)}
      </span>
      <span className="w-36 shrink-0 truncate text-gx-12 text-gx-text-tertiary">
        {fmtTs(run.createdAt)}
      </span>
    </div>
  );
}

function WorkflowRunPager({
  page,
  total,
  busy,
  onPage,
}: {
  page: number;
  total: number;
  busy: boolean;
  onPage: (next: number) => void;
}) {
  const ps = workflowPageState(page, WORKFLOW_DEFAULT_PAGE_SIZE, total);
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-gx-hairline bg-gx-surface px-4 py-2 text-gx-11 text-gx-text-hint">
      <span className="min-w-0 flex-1 truncate">
        第 {ps.from}–{ps.to} 条 · 共 {ps.total} 条
      </span>
      <button
        type="button"
        aria-label="上一页"
        disabled={!ps.canPrev || busy}
        onClick={() => onPage(prevPage(ps))}
        className="inline-flex h-7 w-7 items-center justify-center rounded-gx-sm border border-gx-border text-gx-text-secondary hover:bg-gx-bg disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon name="chevronLeft" size={14} />
      </button>
      <button
        type="button"
        aria-label="下一页"
        disabled={!ps.canNext || busy}
        onClick={() => onPage(nextPage(ps))}
        className="inline-flex h-7 w-7 items-center justify-center rounded-gx-sm border border-gx-border text-gx-text-secondary hover:bg-gx-bg disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon name="chevronRight" size={14} />
      </button>
    </div>
  );
}

export function WorkflowRunList() {
  const [searchParams] = useSearchParams();
  const defId = searchParams.get("defId")?.trim() || undefined;
  const [page, setPage] = useState(1);
  const listQ = useWorkflowRuns({ page, limit: WORKFLOW_DEFAULT_PAGE_SIZE, defId });
  const items = listQ.data?.items ?? [];
  const total = listQ.data?.total ?? 0;

  if (listQ.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  if (listQ.isError) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-gx-lg border border-gx-separator bg-gx-bg px-6 py-12 text-center">
        <Icon name="alertCircle" size={22} className="text-gx-warning" />
        <p className="m-0 text-gx-13 text-gx-text-secondary">
          {workflowErrorText(normalizeWorkflowError(listQ.error))}
        </p>
        <Button variant="ghost" size="sm" icon="refresh" onClick={() => listQ.refetch()}>
          重试
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {defId ? <FilterChip defId={defId} /> : null}
        <EmptyState
          icon="workflow"
          title={defId ? "该流程暂无运行记录" : "还没有运行记录"}
          description={
            defId
              ? "当前筛选的流程还没有产生过运行，可清除筛选查看全部运行记录。"
              : "流程被手动或自动触发后，运行历史会显示在这里。"
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {defId ? <FilterChip defId={defId} /> : null}
      <div className="rounded-gx-lg border border-gx-border">
        <div className="flex items-center gap-3 border-b border-gx-separator bg-gx-table-header px-3 py-2 text-gx-12 font-medium text-gx-text-secondary">
          <span className="w-32 shrink-0">运行编号</span>
          <span className="w-28 shrink-0">所属流程</span>
          <span className="w-24 shrink-0">状态</span>
          <span className="w-24 shrink-0">触发方式</span>
          <span className="w-24 shrink-0">当前节点</span>
          <span className="min-w-0 flex-1">失败原因</span>
          <span className="w-36 shrink-0">创建时间</span>
        </div>
        {items.map((run) => (
          <WorkflowRunRow key={run.id} run={run} />
        ))}
      </div>
      <WorkflowRunPager page={page} total={total} busy={listQ.isLoading} onPage={setPage} />
    </div>
  );
}
