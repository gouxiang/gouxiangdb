// 自研工作流引擎（#1296）刀 B1：运行实例执行器——DAG 推进、审批暂停、成败落库。
//
// 职责边界：本文件只做调度与状态机，真正的"落库动作 + 权限链"在 actionExec.ts（权限不穿洞）。
// 状态机（run.status）：
//   pending --runtime 条件认领--> running --全部节点 done--> succeeded
//                              running --遇 approval 节点--> waiting_approval（建 pending 审批后暂停）
//                              waiting_approval --批准--> running 续跑（可重入，进度在 context）
//                              waiting_approval --驳回--> canceled
//                              任一节点抛错 --> failed（error 落库，动作节点自身事务已回滚无半条记录）
//
// 可重入：进度只存在 workflow_runs.context（doneNodeIds/nodeOutputs），每完成一个节点就落盘；
// 进程崩在中途，下一轮重新认领后从 context 断点继续，不重复已 done 节点（action 非幂等风险靠此收口）。

import type { Prisma } from "@prisma/client";
import { prisma, withWriteTx } from "../../db.js";
import { HttpError } from "../../httpError.js";
import { executeActionNode } from "./actionExec.js";
import { parseWorkflowGraph, readyNodes, startNodeId } from "./graph.js";
import type {
  ActionNodeConfig,
  RunContext,
  WorkflowGraph,
  WorkflowNode,
} from "./types.js";
import { EMPTY_RUN_CONTEXT } from "./types.js";

const MAX_ERR = 500;
const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > MAX_ERR ? m.slice(0, MAX_ERR) : m;
}

/** 沿 `a.b.c` 路径在节点产出里取值；任一跳缺失返回 undefined。 */
function lookupPath(outputs: RunContext["nodeOutputs"], path: string): unknown {
  const [nodeId, ...rest] = path.split(".");
  if (!nodeId) return undefined;
  let cur: unknown = outputs[nodeId];
  for (const key of rest) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * 渲染字符串里的 `{{nodeId.field}}` 占位。
 * 整串恰为一个占位时保留原值类型（数字/布尔/null 不字符串化）；否则按文本拼接。
 * 任一占位无法解析 -> 400 WORKFLOW_PLACEHOLDER_UNRESOLVED（fail-closed，不写空值蒙混）。
 */
export function renderString(raw: string, ctx: RunContext): unknown {
  const matches = [...raw.matchAll(PLACEHOLDER_RE)];
  if (matches.length === 1 && matches[0] && matches[0][0].trim() === raw.trim()) {
    const v = lookupPath(ctx.nodeOutputs, matches[0][1].trim());
    if (v === undefined) {
      throw new HttpError(400, `工作流占位无法解析：${raw}`, "WORKFLOW_PLACEHOLDER_UNRESOLVED");
    }
    return v;
  }
  return raw.replace(PLACEHOLDER_RE, (whole, path: string) => {
    const v = lookupPath(ctx.nodeOutputs, path.trim());
    if (v === undefined) {
      throw new HttpError(400, `工作流占位无法解析：${whole}`, "WORKFLOW_PLACEHOLDER_UNRESOLVED");
    }
    return v === null ? "" : String(v);
  });
}

/** 递归渲染 payload（对象/数组/字符串），非字符串值原样返回。 */
function renderValue(value: unknown, ctx: RunContext): unknown {
  if (typeof value === "string") return renderString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderValue(v, ctx));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderValue(v, ctx);
    return out;
  }
  return value;
}

/** 渲染动作节点配置（payload 与 update 的 recordId 都可能含占位）。 */
function renderActionConfig(node: WorkflowNode, ctx: RunContext): ActionNodeConfig {
  const cfg = node.config as ActionNodeConfig;
  const rendered = renderValue(cfg.payload, ctx) as Record<string, unknown>;
  return {
    op: cfg.op,
    tableId: cfg.tableId,
    payload: rendered,
    ...(cfg.recordId !== undefined
      ? { recordId: String(renderValue(cfg.recordId, ctx)) }
      : {}),
  };
}

function parseRunContext(raw: string): RunContext {
  try {
    const parsed = JSON.parse(raw) as Partial<RunContext>;
    return {
      doneNodeIds: Array.isArray(parsed.doneNodeIds) ? parsed.doneNodeIds : [],
      nodeOutputs: parsed.nodeOutputs && typeof parsed.nodeOutputs === "object" ? parsed.nodeOutputs : {},
    };
  } catch {
    return { ...EMPTY_RUN_CONTEXT };
  }
}

async function saveProgress(
  runId: string,
  ctx: RunContext,
  patch: Prisma.WorkflowRunUncheckedUpdateInput,
): Promise<void> {
  await withWriteTx("workflow.run.progress", (tx) =>
    tx.workflowRun.update({
      where: { id: runId },
      data: { context: JSON.stringify(ctx), ...patch },
    }));
}

/** 该审批节点是否已存在 pending 审批（幂等：续跑不重复建）。 */
async function hasPendingApproval(runId: string, nodeId: string): Promise<boolean> {
  const n = await prisma.workflowApproval.count({ where: { runId, nodeId, status: "pending" } });
  return n > 0;
}

/**
 * 该审批节点是否已被【批准】（仅 approved 算通过）。
 * 批准续跑时靠它把审批节点判为完成、继续放开后继；否则 readyNodes 会反复吐出该节点、
 * 又因旧审批已非 pending 而重复建新审批，导致运行永远卡在审批（沉默逻辑错误）。
 * rejected 不算通过：驳回时 service 已把 run 置 canceled 终态，runtime 只认领 pending，
 * 该 run 不会再进 advanceRun；即便误入也 fail-closed 地重建审批暂停，绝不越过驳回门。
 */
async function isApprovalApproved(runId: string, nodeId: string): Promise<boolean> {
  const n = await prisma.workflowApproval.count({
    where: { runId, nodeId, status: "approved" },
  });
  return n > 0;
}

/**
 * 推进一个 running 实例直到：遇审批暂停 / 全部成功 / 抛错落 failed。
 * 只应由 executeRun（pending 认领后）或 resumeAfterApproval（批准后续跑）调用。
 */
async function advanceRun(runId: string): Promise<void> {
  const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
  if (!run) throw new HttpError(404, "工作流运行不存在", "WORKFLOW_RUN_NOT_FOUND");
  const actor = run.createdBy;
  if (!actor) {
    await saveProgress(runId, parseRunContext(run.context), {
      status: "failed", error: "工作流缺少发起人，无法以登录态权限执行动作", finishedAt: new Date(),
    });
    return;
  }

  const def = await prisma.workflowDef.findUnique({ where: { id: run.defId } });
  if (!def) {
    await saveProgress(runId, parseRunContext(run.context), {
      status: "failed", error: "工作流定义不存在或已删除", finishedAt: new Date(),
    });
    return;
  }

  const graph: WorkflowGraph = parseWorkflowGraph(def.graph);
  const ctx = parseRunContext(run.context);
  // 锚定入口（校验已保证唯一 trigger），确保 trigger 一定先被消费。
  startNodeId(graph);

  const guard = graph.nodes.length + 1;
  let steps = 0;
  while (steps < guard) {
    steps += 1;
    const ready = readyNodes(graph, ctx.doneNodeIds);
    if (ready.length === 0) break;

    for (const node of ready) {
      if (node.type === "trigger") {
        ctx.doneNodeIds.push(node.id);
        ctx.nodeOutputs[node.id] = { triggeredAt: new Date().toISOString() };
        await saveProgress(runId, ctx, {});
        continue;
      }

      if (node.type === "approval") {
        // 三态幂等（续跑可重入的关键）：
        //   已批准（approved）          -> 本节点视为完成，放开后继继续推进；
        //   仍有 pending 审批           -> 保持暂停，不重复建单；
        //   首次到达（无任何审批单）     -> 建一条 pending 后暂停。
        if (await isApprovalApproved(runId, node.id)) {
          ctx.doneNodeIds.push(node.id);
          await saveProgress(runId, ctx, { currentNodeId: node.id });
          continue;
        }
        if (!(await hasPendingApproval(runId, node.id))) {
          await withWriteTx("workflow.approval.create", (tx) =>
            tx.workflowApproval.create({
              data: { runId, nodeId: node.id, status: "pending" },
            }));
        }
        await saveProgress(runId, ctx, { status: "waiting_approval", currentNodeId: node.id });
        return; // 暂停：等人工 decideApproval 后续跑。
      }

      // action：渲染占位 -> 以发起人身份过完整权限链落库。
      const cfg = renderActionConfig(node, ctx);
      const outcome = await executeActionNode(cfg, actor);
      ctx.doneNodeIds.push(node.id);
      ctx.nodeOutputs[node.id] = { ...outcome.output };
      await saveProgress(runId, ctx, { currentNodeId: node.id });
    }
  }

  const allDone = graph.nodes.every((n) => ctx.doneNodeIds.includes(n.id));
  await saveProgress(runId, ctx, allDone
    ? { status: "succeeded", currentNodeId: null, finishedAt: new Date() }
    : { status: "failed", error: "工作流存在无法到达的节点，未能全部完成", finishedAt: new Date() });
}

/** runtime 认领（pending->running）后调用：推进实例，任何异常收敛为 run.failed 而非上抛炸进程。 */
export async function executeRun(runId: string): Promise<void> {
  try {
    await advanceRun(runId);
  } catch (e) {
    const run = await prisma.workflowRun.findUnique({ where: { id: runId }, select: { context: true } });
    const ctx = run ? parseRunContext(run.context) : { ...EMPTY_RUN_CONTEXT };
    await saveProgress(runId, ctx, {
      status: "failed", error: errText(e), finishedAt: new Date(),
    }).catch(() => {
      // 连失败落库都失败（库已关）时不再二次抛出，runtime 兜底吞错；锁靠 stalled 接管。
    });
  }
}

/** 审批批准后续跑：先把 run 拉回 running，再从 context 断点推进。 */
export async function resumeAfterApproval(runId: string): Promise<void> {
  await withWriteTx("workflow.run.resume", (tx) =>
    tx.workflowRun.update({ where: { id: runId }, data: { status: "running" } }));
  await advanceRun(runId);
}
