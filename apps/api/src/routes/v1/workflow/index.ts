// /api/v1/workflow：自研工作流引擎 HTTP 面（#1296 刀 B2，把刀 B1 的 domain/workflow 内核通电）。
//
// 挂载纪律（与 /api/v1/sync、/api/v1/search「恒挂载 + 请求期闸门」同款，刻意区别于按启动 flag 静态摘挂）：
//   - 本子路由在 app.ts 中【独立于企业双 flag】恒挂到 mount 的 /api/v1/workflow；即使
//     GX_ENTERPRISE_ORG/NAV 全 off，工作流面仍只由自己的总门 GX_WORKFLOW_ENGINE 决定可达性，
//     且挂载点排在企业 v1 全局鉴权之前，保证 off 的 404 不会被 v1 的 401 抢先。
//   - 组首中间件每次请求读 env 判定（workflowEngineEnabled）：off（出厂默认，含未设/空白/笔误如 opn）
//     在【任何 DB 访问之前】直接 404 WORKFLOW_DISABLED，默认安装不写任何 workflow_* 表、不暴露能力，
//     旧行为逐字节不变；on 才继续鉴权链与各端点。运维改 env 无需重启即生效，测试也能同进程切开/关。
//
// 分层纪律：本文件只做参数形状校验 + 调 domain/workflow/workflowService + 组装响应/审计，不直接碰 Prisma；
// 域服务已用零依赖 HttpError 抛 4xx，这里让其冒泡交全局 errorResponse 收口，绝不吞错。
// v1 无 zod，统一手动 typeof/trim 校验；成功裸返回资源、无 {data} 信封（同 pats.ts/sync 风格）。

import { Hono } from "hono";
import { workflowEngineEnabled } from "../../../configWorkflow.js";
import { HttpError } from "../../../httpError.js";
import { requireActiveUser } from "../../../middleware/authActive.js";
import { audit } from "../../../audit/emit.js";
import {
  createWorkflowDef,
  publishWorkflowDef,
  listWorkflowDefs,
  getWorkflowDef,
  triggerWorkflow,
  decideApproval,
  listRuns,
  getRun,
  type TriggerWorkflowInput,
} from "../../../domain/workflow/workflowService.js";
import { WORKFLOW_TRIGGER_TYPES, type WorkflowTriggerType } from "../../../domain/workflow/types.js";

export const workflowRoutes = new Hono();

// ① 总门 fail-closed：最先执行，off 即 404，短路在鉴权/DB 之前（默认零行为、零额外写）。
workflowRoutes.use("*", async (_c, next) => {
  if (!workflowEngineEnabled()) {
    throw new HttpError(404, "工作流引擎未启用", "WORKFLOW_DISABLED");
  }
  return next();
});

// ② 鉴权：工作流面全部要求登录且账号 ACTIVE/tv 匹配（与 v1 主链同源，X-GX-Token/Authorization 均收）。
workflowRoutes.use("*", requireActiveUser);

/** 分页 query 解析：正整数原样返回，缺省/非数/非正/小数一律回落 undefined（交域服务用默认值）。 */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// ───────────────────────── 流程定义 defs ─────────────────────────

/** POST /defs：新建定义（强制 draft）。name 非空、graph 必须是字符串；图内容合法性交域层 parse+validate。 */
workflowRoutes.post("/defs", async (c) => {
  const userId = c.get("auth").userId;
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name === "") throw new HttpError(400, "工作流名称不能为空", "WORKFLOW_NAME_EMPTY");
  if (typeof raw.graph !== "string") {
    throw new HttpError(400, "工作流图 graph 必须是 JSON 字符串", "WORKFLOW_GRAPH_INVALID");
  }

  // triggerType 可选；一旦携带就必须是冻结白名单内的字符串，否则确定性 400（不透传未知值进域层）。
  let triggerType: WorkflowTriggerType | undefined;
  if (raw.triggerType !== undefined && raw.triggerType !== null) {
    if (
      typeof raw.triggerType !== "string"
      || !WORKFLOW_TRIGGER_TYPES.includes(raw.triggerType as WorkflowTriggerType)
    ) {
      throw new HttpError(400, "非法的触发器类型", "WORKFLOW_TRIGGER_INVALID");
    }
    triggerType = raw.triggerType as WorkflowTriggerType;
  }
  const description = typeof raw.description === "string" ? raw.description : undefined;
  const triggerConfig =
    raw.triggerConfig && typeof raw.triggerConfig === "object" && !Array.isArray(raw.triggerConfig)
      ? (raw.triggerConfig as Record<string, unknown>)
      : undefined;

  const created = await createWorkflowDef(
    {
      name,
      graph: raw.graph,
      ...(triggerType ? { triggerType } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(triggerConfig ? { triggerConfig } : {}),
    },
    userId,
  );
  // 审计 detail 只落标识，绝不落 graph/字段明文。
  audit(c, { event: "workflow_def_created", status: 201, actorId: userId, detail: { defId: created.id } });
  return c.json(created, 201);
});

/** POST /defs/:id/publish：仅 draft 可发布（域层守卫 404/409），成功 204。 */
workflowRoutes.post("/defs/:id/publish", async (c) => {
  const userId = c.get("auth").userId;
  const defId = c.req.param("id");
  await publishWorkflowDef(defId, userId);
  audit(c, { event: "workflow_def_published", status: 204, actorId: userId, detail: { defId } });
  return c.body(null, 204);
});

/** GET /defs?page=&limit=：分页列出定义，裸返回 {items,total}。 */
workflowRoutes.get("/defs", async (c) => {
  const page = parsePositiveInt(c.req.query("page"));
  const limit = parsePositiveInt(c.req.query("limit"));
  return c.json(await listWorkflowDefs(page, limit));
});

/** GET /defs/:id：取单个定义，不存在由域层抛 404 WORKFLOW_DEF_NOT_FOUND。 */
workflowRoutes.get("/defs/:id", async (c) => {
  return c.json(await getWorkflowDef(c.req.param("id")));
});

/** POST /defs/:id/trigger：手动触发，仅 published 可触发（域层 409），建一条 pending run，201 回 run id。 */
workflowRoutes.post("/defs/:id/trigger", async (c) => {
  const userId = c.get("auth").userId;
  const defId = c.req.param("id");
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  // body 整体可选；只接收形状正确的字段，其余忽略。
  const body: TriggerWorkflowInput = {};
  if (typeof raw.entityType === "string") body.entityType = raw.entityType;
  if (typeof raw.entityId === "string") body.entityId = raw.entityId;
  if (raw.input && typeof raw.input === "object" && !Array.isArray(raw.input)) {
    body.input = raw.input as Record<string, unknown>;
  }

  const triggered = await triggerWorkflow(defId, userId, body);
  audit(c, {
    event: "workflow_run_triggered",
    status: 201,
    actorId: userId,
    detail: { defId, runId: triggered.id },
  });
  return c.json(triggered, 201);
});

// ───────────────────────── 人工审批 approvals ─────────────────────────

/** POST /approvals/:id/decide：裁决结论只收 approved/rejected，缺省/pending/其它值一律 400。 */
workflowRoutes.post("/approvals/:id/decide", async (c) => {
  const userId = c.get("auth").userId;
  const approvalId = c.req.param("id");
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const decision = raw.decision;
  if (decision !== "approved" && decision !== "rejected") {
    throw new HttpError(400, "审批结论必须是 approved 或 rejected", "WORKFLOW_APPROVAL_INVALID");
  }
  const comment = typeof raw.comment === "string" ? raw.comment : null;
  // 路由已收窄为 approved/rejected；域层仍保留 pending/非法值入口守卫作纵深防御，二者不冲突。
  await decideApproval(approvalId, userId, { decision, comment });
  audit(c, {
    event: "workflow_approval_decided",
    status: 204,
    actorId: userId,
    detail: { approvalId, decision },
  });
  return c.body(null, 204);
});

// ───────────────────────── 运行实例 runs ─────────────────────────

/** GET /runs?defId=&page=&limit=：分页列出运行，可按 defId 过滤，裸返回 {items,total}。 */
workflowRoutes.get("/runs", async (c) => {
  const defIdRaw = (c.req.query("defId") ?? "").trim();
  const defId = defIdRaw === "" ? undefined : defIdRaw;
  const page = parsePositiveInt(c.req.query("page"));
  const limit = parsePositiveInt(c.req.query("limit"));
  return c.json(await listRuns(defId, page, limit));
});

/** GET /runs/:id：取单个运行及其全部审批单（{run,approvals}），不存在域层 404 WORKFLOW_RUN_NOT_FOUND。 */
workflowRoutes.get("/runs/:id", async (c) => {
  return c.json(await getRun(c.req.param("id")));
});
