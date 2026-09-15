// M4/S5 策略管理端点的路由内授权判定（不做成中间件：写授权是"组织动作 OR 资源动作"取或，
// 且只作用于 policies/effective 两个端点，不污染共享中间件链）。
//
// 两个命名空间互不替代（commit ② 隔离纪律）：
//   - 组织空间 manage_share：角色 permissions（ORG_ACTIONS），经 hasOrgAction 求值，工作区级；
//   - 资源空间 manage_share：auth_policies.actions（RESOURCE_ACTIONS），经引擎 decide 求值，节点级
//     （含沿祖先继承 + 实体 createdBy / workspace owner 兜底）。
// 纯域：只依赖注入 client，不 import Hono。

import { hasOrgAction } from "../org/authorization.js";
import { prisma } from "../../db.js";
import { decide, type EngineDeps } from "./engine.js";
import { resolveSubject } from "./subjects.js";
import { makeCreatedByResolver } from "./adapter.js";
import type { AuthzClient } from "./types.js";

async function nodeAllows(
  client: AuthzClient,
  userId: string,
  nodeId: string,
  action: "r" | "manage_share",
): Promise<boolean> {
  const subject = await resolveSubject(userId, client);
  const deps: EngineDeps = {
    client,
    resolveCreatedBy: makeCreatedByResolver(client),
  };
  const result = await decide(deps, subject, nodeId, action);
  return result.decision.allowed;
}

/** 读策略/决策解释：对该节点有 r 即放行（workspace owner / 实体 creator 经引擎兜底已含）。 */
export async function canReadNodePolicy(
  userId: string,
  nodeId: string,
  client: AuthzClient = prisma,
): Promise<boolean> {
  return await nodeAllows(client, userId, nodeId, "r");
}

/**
 * 写策略/查他人 effective：组织 manage_share（工作区角色）或对该节点资源 manage_share
 * （直接/继承/兜底）任一成立即放行。两者是不同命名空间，取或不是同一份权限的两次判断。
 */
export async function canManageNodeShare(
  userId: string,
  nodeId: string,
  client: AuthzClient = prisma,
): Promise<boolean> {
  const [orgAllowed, nodeAllowed] = await Promise.all([
    hasOrgAction(userId, "manage_share", client),
    nodeAllows(client, userId, nodeId, "manage_share"),
  ]);
  return orgAllowed || nodeAllowed;
}
