// 自研工作流引擎（#1296）刀 B1：领域服务——流程定义/发布/触发/审批裁决/查询编排。
//
// 纪律同 libraryService：入参规整 + withWriteTx，事务体内只用传入 tx；不 import Hono/guards，
// 4xx 一律用零依赖 httpError 的 HttpError。本文件不做 HTTP 组响应（那是 B2 路由层的事），
// 只承载"已通过总门与登录态之后"的领域写入与查询。
//
// 状态流转（def.status）：draft --publish--> published；published --disable--> disabled（后续刀补）。
// run/approval 的运行态枚举见 types.ts，字面量为冻结值，不得改写。

import { prisma, withWriteTx } from "../../db.js";
import { HttpError } from "../../httpError.js";
import { parseWorkflowGraph, validateWorkflowGraph } from "./graph.js";
import { resumeAfterApproval } from "./executor.js";
import {
  WORKFLOW_APPROVAL_STATUSES,
  WORKFLOW_TRIGGER_TYPES,
  type WorkflowApprovalStatus,
  type WorkflowTriggerType,
} from "./types.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface CreateWorkflowDefInput {
  name: string;
  description?: string | null;
  triggerType?: WorkflowTriggerType;
  triggerConfig?: Record<string, unknown>;
  /** DAG 图 JSON 文本（落库前 parse + 全量校验）。 */
  graph: string;
}

/** 新建流程定义：强制 draft，图不合法直接 400，不落库。 */
export async function createWorkflowDef(input: CreateWorkflowDefInput, userId: string): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name === "") throw new HttpError(400, "工作流名称不能为空", "WORKFLOW_NAME_EMPTY");
  const triggerType = input.triggerType ?? "manual";
  if (!WORKFLOW_TRIGGER_TYPES.includes(triggerType)) {
    throw new HttpError(400, "非法的触发器类型", "WORKFLOW_TRIGGER_INVALID");
  }
  // 落库前校验：坏图在入口就被挡，绝不存一个跑不起来的定义。
  validateWorkflowGraph(parseWorkflowGraph(input.graph));

  return withWriteTx("workflow.def.create", (tx) =>
    tx.workflowDef.create({
      data: {
        name,
        description: input.description ?? null,
        triggerType,
        triggerConfig: JSON.stringify(input.triggerConfig ?? {}),
        graph: input.graph,
        status: "draft",
        version: 1,
        createdBy: userId,
        updatedBy: userId,
      },
      select: { id: true },
    }));
}

/** 发布：仅 draft 可发布；发布前再校验一次图（防存量脏数据）。 */
export async function publishWorkflowDef(defId: string, userId: string): Promise<void> {
  await withWriteTx("workflow.def.publish", async (tx) => {
    const def = await tx.workflowDef.findUnique({ where: { id: defId } });
    if (!def) throw new HttpError(404, "工作流定义不存在", "WORKFLOW_DEF_NOT_FOUND");
    if (def.status !== "draft") {
      throw new HttpError(409, "仅草稿状态的工作流可发布", "WORKFLOW_DEF_NOT_DRAFT");
    }
    validateWorkflowGraph(parseWorkflowGraph(def.graph));
    await tx.workflowDef.update({
      where: { id: defId },
      data: { status: "published", updatedBy: userId },
    });
  });
}

/** 分页列出定义（默认按创建时间倒序，有界）。 */
export async function listWorkflowDefs(page = 1, limit = DEFAULT_PAGE_SIZE): Promise<{
  items: Awaited<ReturnType<typeof prisma.workflowDef.findMany>>;
  total: number;
}> {
  const p = Number.isInteger(page) && page > 0 ? page : 1;
  const l = Math.min(Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const [items, total] = await Promise.all([
    prisma.workflowDef.findMany({ orderBy: { createdAt: "desc" }, skip: (p - 1) * l, take: l }),
    prisma.workflowDef.count(),
  ]);
  return { items, total };
}

export async function getWorkflowDef(defId: string) {
  const def = await prisma.workflowDef.findUnique({ where: { id: defId } });
  if (!def) throw new HttpError(404, "工作流定义不存在", "WORKFLOW_DEF_NOT_FOUND");
  return def;
}

export interface TriggerWorkflowInput {
  entityType?: string | null;
  entityId?: string | null;
  input?: Record<string, unknown>;
}

/** 手动触发：只有 published 定义可触发，否则 409；建一条 pending run 等 runtime 轮询认领。 */
export async function triggerWorkflow(
  defId: string,
  userId: string,
  body: TriggerWorkflowInput = {},
): Promise<{ id: string }> {
  const def = await prisma.workflowDef.findUnique({ where: { id: defId }, select: { status: true, triggerType: true } });
  if (!def) throw new HttpError(404, "工作流定义不存在", "WORKFLOW_DEF_NOT_FOUND");
  if (def.status !== "published") {
    throw new HttpError(409, "工作流未发布，不能触发", "WORKFLOW_DEF_NOT_PUBLISHED");
  }
  return withWriteTx("workflow.run.trigger", (tx) =>
    tx.workflowRun.create({
      data: {
        defId,
        status: "pending",
        triggerType: def.triggerType,
        entityType: body.entityType ?? null,
        entityId: body.entityId ?? null,
        input: JSON.stringify(body.input ?? {}),
        context: JSON.stringify({ doneNodeIds: [], nodeOutputs: {} }),
        createdBy: userId,
      },
      select: { id: true },
    }));
}

/** 取审批节点配置里的审批人白名单；空/缺省表示不限制（任意有权者可审批）。 */
function approverWhitelist(graphRaw: string, nodeId: string): string[] {
  const graph = parseWorkflowGraph(graphRaw);
  const node = graph.nodes.find((n) => n.id === nodeId);
  const ids = (node?.config as { approverIds?: unknown } | undefined)?.approverIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

export interface DecideApprovalInput {
  /**
   * 放宽为含 pending 的完整审批状态联合：这是服务边界，B2 路由会把 HTTP 解析体透传进来，
   * 运行时确实可能收到 pending/非法值。pending 由下方 decideApproval 入口守卫挡成
   * 400 WORKFLOW_APPROVAL_INVALID（不在类型层收窄，否则该运行时守卫会变成恒假的死分支）。
   */
  decision: WorkflowApprovalStatus;
  comment?: string | null;
}

/**
 * 人工裁决一个审批节点。
 * 非白名单审批人 -> 403 WORKFLOW_NOT_APPROVER；驳回 -> run canceled；批准 -> 若无同节点其它
 * 待审批则续跑（resumeAfterApproval 从 context 断点推进）。
 */
export async function decideApproval(
  approvalId: string,
  userId: string,
  body: DecideApprovalInput,
): Promise<void> {
  if (!WORKFLOW_APPROVAL_STATUSES.includes(body.decision) || body.decision === "pending") {
    throw new HttpError(400, "审批结论必须是 approved 或 rejected", "WORKFLOW_APPROVAL_INVALID");
  }
  const approval = await prisma.workflowApproval.findUnique({ where: { id: approvalId } });
  if (!approval) throw new HttpError(404, "审批单不存在", "WORKFLOW_APPROVAL_NOT_FOUND");
  if (approval.status !== "pending") {
    throw new HttpError(409, "该审批已裁决，不能重复操作", "WORKFLOW_APPROVAL_DECIDED");
  }
  const run = await prisma.workflowRun.findUnique({ where: { id: approval.runId } });
  if (!run) throw new HttpError(404, "审批对应的运行不存在", "WORKFLOW_RUN_NOT_FOUND");
  const def = await prisma.workflowDef.findUnique({ where: { id: run.defId }, select: { graph: true } });
  if (!def) throw new HttpError(404, "工作流定义不存在", "WORKFLOW_DEF_NOT_FOUND");

  const whitelist = approverWhitelist(def.graph, approval.nodeId);
  if (whitelist.length > 0 && !whitelist.includes(userId)) {
    throw new HttpError(403, "你不是该审批节点的指定审批人", "WORKFLOW_NOT_APPROVER");
  }

  const now = new Date();
  if (body.decision === "rejected") {
    await withWriteTx("workflow.approval.reject", (tx) =>
      Promise.all([
        tx.workflowApproval.update({
          where: { id: approvalId },
          data: { status: "rejected", approverId: userId, comment: body.comment ?? null, decidedAt: now },
        }),
        tx.workflowRun.update({
          where: { id: run.id },
          data: { status: "canceled", finishedAt: now, currentNodeId: approval.nodeId },
        }),
      ]));
    return;
  }

  await withWriteTx("workflow.approval.approve", (tx) =>
    tx.workflowApproval.update({
      where: { id: approvalId },
      data: { status: "approved", approverId: userId, comment: body.comment ?? null, decidedAt: now },
    }));
  // 同节点仍有其它待审批时不续跑（等全部批准）；否则从断点恢复运行。
  const remaining = await prisma.workflowApproval.count({
    where: { runId: run.id, nodeId: approval.nodeId, status: "pending" },
  });
  if (remaining === 0) await resumeAfterApproval(run.id);
}

/** 分页列出运行实例（可按 defId 过滤）。 */
export async function listRuns(defId?: string, page = 1, limit = DEFAULT_PAGE_SIZE): Promise<{
  items: Awaited<ReturnType<typeof prisma.workflowRun.findMany>>;
  total: number;
}> {
  const p = Number.isInteger(page) && page > 0 ? page : 1;
  const l = Math.min(Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const where = defId ? { defId } : undefined;
  const [items, total] = await Promise.all([
    prisma.workflowRun.findMany({ where, orderBy: { createdAt: "desc" }, skip: (p - 1) * l, take: l }),
    prisma.workflowRun.count({ where }),
  ]);
  return { items, total };
}

/** 取单个运行（带其全部审批单）；不存在 404。 */
export async function getRun(runId: string) {
  const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
  if (!run) throw new HttpError(404, "工作流运行不存在", "WORKFLOW_RUN_NOT_FOUND");
  const approvals = await prisma.workflowApproval.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
  });
  return { run, approvals };
}
