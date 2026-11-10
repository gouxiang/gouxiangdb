// 自研工作流引擎（#1296）刀 B1：动作节点执行器——【权限不穿洞】的落库通道。
//
// 铁律：工作流不是超级用户。动作节点一律以【发起人】（workflow_runs.createdBy）的身份，
// 重走一遍登录态写记录的完整权限链，绝不因为是"系统自动执行"就绕过任何一道闸。
// 与 routes/records.ts 创建(176-217)/更新(433-467)两条路径逐环对齐，只去掉 Hono Context：
//
//   ① resolveBaseAccessByTable(actor, tableId)   替 requireCanEditData（域函数，不依赖 Hono）
//      - null / visible=false                        -> 403（库都进不去）
//      - tableAccessOf 精确校验 create/update 位      -> 403（比路由的库级并集更严，不放权）
//   ② loadTableFields(tableId)                     加载全字段定义（fieldGate/mask 都要它）
//   ③ resolveTableMask + runMaskWriteGate          新引擎字段掩码写键守卫（事务前，整单不开事务）
//   ④ fieldWriteGate(access, ...)                  角色 × 库字段三档（仅可见/隐藏不可写），事务内再挡
//   ⑤ withWriteTx(createRecordTx/updateRecordTx)   串行写队列 + 交互事务，失败整体回滚无半条记录
//
// 任一道闸抛 HttpError 都原样上抛给 executor，由其把 run 置 failed；事务体内的拒绝随回滚不落任何记录。

import { prisma, withWriteTx } from "../../db.js";
import { HttpError } from "../../httpError.js";
import type { LibraryAccessDTO } from "@gx/shared-types";
import {
  fieldWriteGate,
  resolveBaseAccessByTable,
  tableAccessOf,
} from "../authz/libraryPolicy.js";
import { resolveTableMask } from "../authz/maskGate.js";
import { loadTableFields } from "../recordService.js";
import { createRecordTx, runMaskWriteGate, updateRecordTx } from "../recordWrite.js";
import type { ActionNodeConfig, NodeExecutionOutcome } from "./types.js";

/** 字段 id -> 字段名（错误消息与 fieldGate 用），与 records.ts 路由同款解析器。 */
function fieldNameResolver(fields: Awaited<ReturnType<typeof loadTableFields>>): (id: string) => string {
  return (id) => fields.find((f) => f.id === id)?.name ?? id;
}

/** 库/表层准入：无裁决、不可见、缺对应动作位 -> 403（不穿洞）。通过则返回裁决供字段闸复用。 */
async function assertTableAction(
  actorUserId: string,
  tableId: string,
  op: "create" | "update",
): Promise<LibraryAccessDTO> {
  const access = await resolveBaseAccessByTable(actorUserId, tableId);
  if (!access || !access.visible) {
    throw new HttpError(403, "工作流发起人无权访问目标数据表", "WORKFLOW_ACTION_FORBIDDEN");
  }
  const ta = tableAccessOf(access, tableId);
  const allowed = op === "create" ? ta.create : ta.update;
  if (!allowed) {
    throw new HttpError(
      403,
      op === "create" ? "工作流发起人无权在该表新建记录" : "工作流发起人无权更新该表记录",
      "WORKFLOW_ACTION_FORBIDDEN",
    );
  }
  return access;
}

/** update 前置：目标记录存在、未删且确实属于该表（防跨表写，对齐 PATCH 路由的 rec 校验）。 */
async function assertRecordInTable(tableId: string, recordId: string): Promise<void> {
  const rec = await prisma.record.findUnique({ where: { id: recordId }, select: { tableId: true, deletedAt: true } });
  if (!rec || rec.deletedAt || rec.tableId !== tableId) {
    throw new HttpError(404, "工作流更新目标记录不存在", "WORKFLOW_RECORD_NOT_FOUND");
  }
}

/**
 * 执行一个动作节点（已完成占位渲染的 config 入参）。
 * @returns 落库记录 id 与结构化产出（并入 RunContext.nodeOutputs 供后续节点引用）。
 */
export async function executeActionNode(
  cfg: ActionNodeConfig,
  actorUserId: string,
): Promise<NodeExecutionOutcome> {
  const { op, tableId } = cfg;

  // ① 库/表层权限（不穿洞）；裁决结果复用给字段闸，避免二次查询。
  const access = await assertTableAction(actorUserId, tableId, op);

  // ② 字段定义。
  const fields = await loadTableFields(tableId);

  // update 还需先确认目标记录归属（存在性 404 在掩码/字段闸之前，与路由顺序一致）。
  let recordId: string;
  if (op === "update") {
    const rid = cfg.recordId;
    if (!rid) throw new HttpError(400, "update 动作缺少 recordId", "WORKFLOW_ACTION_CONFIG");
    await assertRecordInTable(tableId, rid);
    recordId = rid;
  } else {
    recordId = "";
  }

  const payload = cfg.payload;

  // ③ 字段掩码写键守卫（事务前；掩码外/只读物理键 -> 403，整单不开事务）。
  const mask = await resolveTableMask(actorUserId, tableId, fields);
  runMaskWriteGate(mask, Object.keys(payload));

  // ④ 角色 × 库字段级写闸（createRecordTx/updateRecordTx 事务体内还会再调一次，双保险）。
  const fieldGate = fieldWriteGate(access, tableId, fieldNameResolver(fields));

  // ⑤ 串行写队列 + 交互事务：任一步失败整体回滚，不留半条记录。
  if (op === "create") {
    const created = await withWriteTx("workflow.action.create", (tx) =>
      createRecordTx(tx, {
        tableId,
        payloadFields: payload,
        fields,
        userId: actorUserId,
        isDraft: false, // 工作流落库一律严格模式（必填兜底生效），不走网格草稿。
        fieldGate,
      }));
    return {
      recordId: created.id,
      output: { recordId: created.id, tableId, op, fields: payload },
    };
  }

  await withWriteTx("workflow.action.update", (tx) =>
    updateRecordTx(tx, { tableId, recordId, patch: payload, fields, userId: actorUserId, fieldGate }));
  return {
    recordId,
    output: { recordId, tableId, op, fields: payload },
  };
}
