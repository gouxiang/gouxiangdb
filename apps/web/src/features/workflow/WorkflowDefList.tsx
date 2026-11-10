// 工作流「流程定义」分页列表（#1318 刀 C3-a2-i）：四态（加载/错误/空/有数据）+ 手写表格 + page 基分页。
//
// 数据只走 useWorkflowDefs（禁裸 fetch，retry:false）；新建编排页在 #1319 /workflow/new，本列表在
// 有数据态操作区与空态 action 各放一个新建入口（用 Link + 按钮样式 class，不嵌套 Button 规避无效 a>button）。
// 枚举一律走 workflow-labels 中文函数，不手写状态字面量；样式只用 gx-* token，Badge 不传 color 走默认灰。
import { useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, EmptyState, Spinner } from "../../components/ui";
import { Icon } from "../../components/icons";
import type { WorkflowDefDTO } from "@gx/shared-types";
import { useWorkflowDefs } from "./workflow-hooks";
import { workflowDefStatusLabel, workflowTriggerTypeLabel } from "./lib/workflow-labels";
import { normalizeWorkflowError, workflowErrorText } from "./lib/workflow-error";
import {
  WORKFLOW_DEFAULT_PAGE_SIZE,
  workflowPageState,
  prevPage,
  nextPage,
} from "./lib/workflow-paging";

/** ISO 时间切片到分钟（2026-09-18T08:30:00.000Z → 2026-09-18 08:30），不引入日期库。 */
function fmtTs(raw: string): string {
  return raw.replace("T", " ").slice(0, 16);
}

function defHref(id: string): string {
  return `/workflow/def/${encodeURIComponent(id)}`;
}

/** 新建流程入口：Link 套主按钮视觉（不嵌套 Button，规避 HTML 里 a>button 的无效嵌套）。 */
function WorkflowNewButton() {
  return (
    <Link
      to="/workflow/new"
      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-gx-lg bg-gx-accent px-3 text-gx-13 font-medium text-white transition-[filter] duration-[120ms] hover:brightness-95"
    >
      <Icon name="plus" size={15} />
      新建流程
    </Link>
  );
}

function WorkflowDefRow({ def }: { def: WorkflowDefDTO }) {
  return (
    <div className="flex items-center gap-3 border-b border-gx-separator px-3 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <Link
          to={defHref(def.id)}
          className="truncate text-gx-13 font-medium text-gx-accent hover:underline"
        >
          {def.name}
        </Link>
      </div>
      <span className="flex w-24">
        <Badge>{workflowDefStatusLabel(def.status)}</Badge>
      </span>
      <span className="w-24 truncate text-gx-12 text-gx-text-secondary">
        {workflowTriggerTypeLabel(def.triggerType)}
      </span>
      <span className="w-14 font-mono text-gx-12 text-gx-text-tertiary">v{def.version}</span>
      <span className="w-36 truncate text-gx-12 text-gx-text-tertiary">{fmtTs(def.updatedAt)}</span>
      <span className="flex w-16 justify-end">
        <Link to={defHref(def.id)} className="text-gx-12 text-gx-accent hover:underline">
          查看
        </Link>
      </span>
    </div>
  );
}

function WorkflowDefPager({
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

export function WorkflowDefList() {
  const [page, setPage] = useState(1);
  const listQ = useWorkflowDefs({ page, limit: WORKFLOW_DEFAULT_PAGE_SIZE });
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
      <EmptyState
        icon="workflow"
        title="还没有流程定义"
        description="点击下方按钮创建第一个流程，编排节点与连线后即可发布使用。"
        action={<WorkflowNewButton />}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <WorkflowNewButton />
      </div>
      <div className="rounded-gx-lg border border-gx-border">
        <div className="flex items-center gap-3 border-b border-gx-separator bg-gx-table-header px-3 py-2 text-gx-12 font-medium text-gx-text-secondary">
          <span className="flex-1">流程名称</span>
          <span className="w-24">状态</span>
          <span className="w-24">触发方式</span>
          <span className="w-14">版本</span>
          <span className="w-36">更新时间</span>
          <span className="w-16 text-right">操作</span>
        </div>
        {items.map((def) => (
          <WorkflowDefRow key={def.id} def={def} />
        ))}
      </div>
      <WorkflowDefPager page={page} total={total} busy={listQ.isLoading} onPage={setPage} />
    </div>
  );
}
