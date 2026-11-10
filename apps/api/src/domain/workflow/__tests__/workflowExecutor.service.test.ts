// 刀 B1 执行器 + 领域服务端到端测试（真迁移临时库 + 真权限链，不 mock authz/db）。
// 复用 navRouteHarness（建 nav 节点，掩码引擎才能点查 table 节点）；workflow 模块牵 db.ts，
// 故在 setupCharHarness 注入临时 __gx_prisma 之后动态 import（同 replicaSyncRuntime.test 纪律）。
// 文件级 timeout 120s（含 prisma migrate deploy 建临时库）。
//
// 五场景：
//   S1 线性 DAG 全绿 + 占位渲染（含坏占位 fail-closed）
//   S2 审批暂停 -> 指定审批人批准 -> 可重入续跑成功
//   S3 审批驳回 -> run canceled 且零落库
//   S4 权限不穿洞：只读发起人跑 create -> run failed 且事务回滚无半条记录
//   S5 非白名单审批人裁决 -> 403 WORKFLOW_NOT_APPROVER，审批仍 pending

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNavHarness, seedBaseWithStarter, type CharHarness } from "../../nav/__tests__/navRouteHarness.js";
import { HttpError } from "../../../httpError.js";
import type { WorkflowGraph } from "../types.js";

type Svc = typeof import("../workflowService.js");
type Exec = typeof import("../executor.js");

let h: CharHarness;
let svc: Svc;
let exec: Exec;
const OWNER = "owner";

function actionNode(id: string, tableId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): WorkflowGraph["nodes"][number] {
  return { id, type: "action", config: { op: "create", tableId, payload, ...extra } };
}
function graph(nodes: WorkflowGraph["nodes"], edges: WorkflowGraph["edges"]): string {
  return JSON.stringify({ nodes, edges });
}

beforeAll(async () => {
  process.env.GX_WORKFLOW_ENGINE = "on";
  h = await makeNavHarness("gx-wf-b1-");
  await h.createUser(OWNER, { email: "wf-owner@x.com", displayName: "发起人" });
  await h.grantRole(OWNER); // role_owner：超管短路 + 掩码宽来源
  svc = await import("../workflowService.js");
  exec = await import("../executor.js");
}, 120_000);

afterAll(async () => {
  delete process.env.GX_WORKFLOW_ENGINE;
  await h.cleanup();
});

async function seedTable(prefix: string): Promise<{ baseId: string; tableId: string; fid: string }> {
  const seeded = await seedBaseWithStarter(h, prefix);
  const fid = `${prefix}_f1`;
  await h.prisma.field.create({
    data: { id: fid, tableId: seeded.tableId, name: "标题", type: "singleLineText", order: 0 },
  });
  return { ...seeded, fid };
}

/** 造一个对目标库仅 visible（只读、无逐表写位）的用户。 */
async function seedReadOnlyUser(userId: string, baseId: string): Promise<void> {
  await h.createUser(userId, { email: `${userId}@x.com`, displayName: userId });
  const roleId = `${userId}_role`;
  await h.prisma.role.create({
    data: { id: roleId, workspaceId: "ws_default", name: `${userId}_r`, isSystem: 0, permissions: "[]" },
  });
  await h.prisma.roleAssignment.create({
    data: { roleId, subjectType: "user", subjectId: userId, scopeType: "workspace", createdBy: OWNER },
  });
  await h.prisma.roleLibraryScope.create({
    data: { roleId, libraryKind: "base", libraryId: baseId, canManage: 0, visible: 1, config: "{}" },
  });
}

async function publishAndTrigger(g: string, actor: string): Promise<string> {
  const def = await svc.createWorkflowDef({ name: `wf-${Math.random()}`, graph: g }, actor);
  await svc.publishWorkflowDef(def.id, actor);
  const run = await svc.triggerWorkflow(def.id, actor);
  return run.id;
}

async function recordCount(tableId: string): Promise<number> {
  return h.prisma.record.count({ where: { tableId, deletedAt: null } });
}

describe("S1 线性 DAG 全绿 + 占位渲染", () => {
  it("trigger->a1->a2 顺序执行，a2 引用 a1 产出占位成功，run succeeded", async () => {
    const tA = await seedTable("wf1a");
    const tB = await seedTable("wf1b");
    const g = graph(
      [
        { id: "tr", type: "trigger" },
        actionNode("a1", tA.tableId, { [tA.fid]: "第一条" }),
        actionNode("a2", tB.tableId, { [tB.fid]: "{{a1.recordId}}" }),
      ],
      [{ from: "tr", to: "a1" }, { from: "a1", to: "a2" }],
    );
    const runId = await publishAndTrigger(g, OWNER);
    await exec.executeRun(runId);

    const run = await h.prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("succeeded");
    expect(await recordCount(tA.tableId)).toBe(1);
    expect(await recordCount(tB.tableId)).toBe(1);
    const ctx = JSON.parse(run.context) as { doneNodeIds: string[] };
    expect(ctx.doneNodeIds).toEqual(["tr", "a1", "a2"]);
  });

  it("坏占位无法解析 -> run failed（WORKFLOW_PLACEHOLDER_UNRESOLVED），零落库", async () => {
    const t = await seedTable("wf1c");
    const g = graph(
      [{ id: "tr", type: "trigger" }, actionNode("a1", t.tableId, { [t.fid]: "{{ghost.x}}" })],
      [{ from: "tr", to: "a1" }],
    );
    const runId = await publishAndTrigger(g, OWNER);
    await exec.executeRun(runId);
    const run = await h.prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("占位无法解析");
    expect(await recordCount(t.tableId)).toBe(0);
  });
});

describe("S2 审批暂停 -> 批准续跑", () => {
  it("遇 approval 暂停建 pending 审批；指定审批人批准后从断点续跑成功", async () => {
    const t = await seedTable("wf2");
    await h.createUser("approver1", { email: "ap1@x.com", displayName: "审批人甲" });
    const g = graph(
      [
        { id: "tr", type: "trigger" },
        { id: "ap", type: "approval", config: { approverIds: ["approver1"] } },
        actionNode("a1", t.tableId, { [t.fid]: "审批后创建" }),
      ],
      [{ from: "tr", to: "ap" }, { from: "ap", to: "a1" }],
    );
    const runId = await publishAndTrigger(g, OWNER);
    await exec.executeRun(runId);

    let run = await h.prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("waiting_approval");
    expect(run.currentNodeId).toBe("ap");
    expect(await recordCount(t.tableId)).toBe(0);
    const approval = await h.prisma.workflowApproval.findFirstOrThrow({ where: { runId, nodeId: "ap" } });
    expect(approval.status).toBe("pending");

    await svc.decideApproval(approval.id, "approver1", { decision: "approved", comment: "同意" });
    run = await h.prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("succeeded");
    expect(await recordCount(t.tableId)).toBe(1);
    const decided = await h.prisma.workflowApproval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(decided.status).toBe("approved");
    expect(decided.approverId).toBe("approver1");
  });
});

describe("S3 审批驳回 -> canceled", () => {
  it("驳回后 run=canceled、审批=rejected，后续动作不执行（零记录）", async () => {
    const t = await seedTable("wf3");
    await h.createUser("approver3", { email: "ap3@x.com", displayName: "审批人丙" });
    const g = graph(
      [
        { id: "tr", type: "trigger" },
        { id: "ap", type: "approval", config: { approverIds: ["approver3"] } },
        actionNode("a1", t.tableId, { [t.fid]: "不应创建" }),
      ],
      [{ from: "tr", to: "ap" }, { from: "ap", to: "a1" }],
    );
    const runId = await publishAndTrigger(g, OWNER);
    await exec.executeRun(runId);
    const approval = await h.prisma.workflowApproval.findFirstOrThrow({ where: { runId, nodeId: "ap" } });

    await svc.decideApproval(approval.id, "approver3", { decision: "rejected", comment: "驳回" });
    const run = await h.prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("canceled");
    expect(await recordCount(t.tableId)).toBe(0);
    expect((await h.prisma.workflowApproval.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe("rejected");
  });
});

describe("S4 权限不穿洞", () => {
  it("只读发起人跑 create：库/表写位在第一道闸被拒，run failed 且无半条记录", async () => {
    const t = await seedTable("wf4");
    await seedReadOnlyUser("ro1", t.baseId);
    const g = graph(
      [{ id: "tr", type: "trigger" }, actionNode("a1", t.tableId, { [t.fid]: "越权写入" })],
      [{ from: "tr", to: "a1" }],
    );
    const runId = await publishAndTrigger(g, "ro1");
    await exec.executeRun(runId);
    const run = await h.prisma.workflowRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe("failed");
    expect(run.error).toContain("无权");
    expect(await recordCount(t.tableId)).toBe(0);
  });
});

describe("S5 审批人白名单", () => {
  it("非指定审批人裁决抛 403 WORKFLOW_NOT_APPROVER，审批保持 pending", async () => {
    const t = await seedTable("wf5");
    await h.createUser("approver5", { email: "ap5@x.com", displayName: "审批人戊" });
    await h.createUser("intruder", { email: "int@x.com", displayName: "局外人" });
    const g = graph(
      [
        { id: "tr", type: "trigger" },
        { id: "ap", type: "approval", config: { approverIds: ["approver5"] } },
        actionNode("a1", t.tableId, { [t.fid]: "x" }),
      ],
      [{ from: "tr", to: "ap" }, { from: "ap", to: "a1" }],
    );
    const runId = await publishAndTrigger(g, OWNER);
    await exec.executeRun(runId);
    const approval = await h.prisma.workflowApproval.findFirstOrThrow({ where: { runId, nodeId: "ap" } });

    await expect(svc.decideApproval(approval.id, "intruder", { decision: "approved" }))
      .rejects.toMatchObject({ status: 403, code: "WORKFLOW_NOT_APPROVER" } satisfies Partial<HttpError>);
    const still = await h.prisma.workflowApproval.findUniqueOrThrow({ where: { id: approval.id } });
    expect(still.status).toBe("pending");
  });
});
