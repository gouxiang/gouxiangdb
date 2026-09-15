// M4/S5 节点授权策略管理端点：
//   GET   /api/v1/nodes/:id/policies   列节点直接策略行 + cutoff 祖先只读继承摘要
//   PUT   /api/v1/nodes/:id/policies   单事务整单写（upserts/deletes），全合法才提交
//   GET   /api/v1/nodes/:id/effective  决策解释器：某用户最终动作集 + 每动作来源链
//
// 挂在 enterpriseNav 的 /nodes 前缀下（无导航节点即无可管理对象）。鉴权在路由内取或，
// 不做成中间件（写授权 = 组织 manage_share OR 节点资源 manage_share，两个命名空间）：
//   - 读：对该节点有 r；
//   - 写：持组织 manage_share（工作区角色）或对该节点 decide(manage_share) 通过；
//   - effective：缺省查本人；查他人需上面同一写授权。
// 错误沿用 {error,code} 信封（不引入新信封），legacyUnmappable 是 200 成功载荷，不是错误码。

import { Hono } from "hono";
import { prisma } from "../../db.js";
import { audit } from "../../audit/emit.js";
import { HttpError } from "../../guards.js";
import { applyPolicyBatch } from "../../domain/authz/policyAdminTx.js";
import { listNodePolicies, explainEffective } from "../../domain/authz/policyQuery.js";
import { canReadNodePolicy, canManageNodeShare } from "../../domain/authz/policyAccess.js";
import { makeCreatedByResolver } from "../../domain/authz/adapter.js";
import { PolicyValidationError, loadTargetNode } from "../../domain/authz/policyAdmin.js";

export const policyRoutes = new Hono();

const VALIDATION_STATUS: Record<PolicyValidationError["code"], number> = {
  POLICY_NODE_NOT_FOUND: 404,
  POLICY_NODE_KIND_INVALID: 409,
  POLICY_SUBJECT_INVALID: 400,
  POLICY_ACTION_INVALID: 400,
  POLICY_FIELD_INVALID: 400,
  POLICY_BAD_INPUT: 400,
};

/** 策略域校验错误 -> 统一 {error,code} 信封；NAV 节点缺失归 404，其余原样冒泡。 */
function toHttpError(e: unknown): never {
  if (e instanceof PolicyValidationError) {
    throw new HttpError(VALIDATION_STATUS[e.code], e.message, e.code);
  }
  if (e instanceof Error && e.message === "NAV_NODE_NOT_FOUND") {
    throw new HttpError(404, "节点不存在或已删除", "NODE_NOT_FOUND");
  }
  throw e;
}

/** 节点存在性预检（404 先于授权）：缺失时 PolicyValidationError->404，避免后续 decide 抛裸 NAV_NODE_NOT_FOUND 成 500。 */
async function assertNodeExists(nodeId: string): Promise<void> {
  try {
    await loadTargetNode(prisma, nodeId);
  } catch (e) {
    toHttpError(e);
  }
}

policyRoutes.get("/:id/policies", async (c) => {
  const actorId = c.get("auth").userId;
  const nodeId = c.req.param("id")!;
  await assertNodeExists(nodeId);
  if (!(await canReadNodePolicy(actorId, nodeId))) {
    throw new HttpError(403, "无权查看该节点的授权策略");
  }
  try {
    const view = await listNodePolicies(prisma, nodeId);
    return c.json(view);
  } catch (e) {
    toHttpError(e);
  }
});

policyRoutes.put("/:id/policies", async (c) => {
  const actorId = c.get("auth").userId;
  const nodeId = c.req.param("id")!;
  await assertNodeExists(nodeId);
  if (!(await canManageNodeShare(actorId, nodeId))) {
    throw new HttpError(403, "无权管理该节点的分享授权（需 manage_share）");
  }
  const body = await c.req.json().catch(() => null);

  let result: Awaited<ReturnType<typeof applyPolicyBatch>>;
  try {
    result = await applyPolicyBatch(nodeId, body, actorId);
  } catch (e) {
    toHttpError(e);
  }

  audit(c, {
    event: "policy_changed",
    status: 200,
    actorId,
    detail: {
      nodeId,
      nodeKind: result.node.kind,
      upserted: result.upserted,
      deleted: result.deleted,
      legacyUnmappable: result.legacyUnmappable,
      before: result.before,
      after: result.after,
    },
  });

  return c.json({
    node: result.node,
    policyVersion: result.policyVersion,
    upserted: result.upserted,
    deleted: result.deleted,
    legacyUnmappable: result.legacyUnmappable,
  });
});

policyRoutes.get("/:id/effective", async (c) => {
  const actorId = c.get("auth").userId;
  const nodeId = c.req.param("id")!;
  const targetUserId = (c.req.query("userId") ?? actorId).trim() || actorId;
  await assertNodeExists(nodeId);

  if (targetUserId !== actorId && !(await canManageNodeShare(actorId, nodeId))) {
    throw new HttpError(403, "查看他人有效权限需要该节点的分享授权管理权限（manage_share）");
  }
  // 即便查本人，也需对节点有 r（否则等于借解释器探测无权节点结构）。
  if (!(await canReadNodePolicy(actorId, nodeId))) {
    throw new HttpError(403, "无权查看该节点的有效权限");
  }

  try {
    const view = await explainEffective(prisma, targetUserId, nodeId, {
      resolveCreatedBy: makeCreatedByResolver(prisma),
    });
    return c.json(view);
  } catch (e) {
    toHttpError(e);
  }
});
