// /api/v1/authz M4 权限引擎探针端点（M4/S4）。
//
// GET /authz/visible-scope：引擎侧只读可见集（M5 先收敛后召回的契约探针 / 前端"无权列表"诊断）。
// 挂在 v1 鉴权链（requireActiveUser）之后；旧 /api 不感知本端点。
// 它直接读 auth_policies/nav_nodes 计算，不经过七守卫。
//
// 授权：默认查本人；显式传 userId 查他人是工作区级排障，要求当前主体持工作区 role_owner
// （manage_share 的工作区兜底形态；资源级 owner 不自动获得跨用户全局诊断权，fail-closed）。

import { Hono } from "hono";
import { prisma } from "../../db.js";
import { HttpError } from "../../guards.js";
import { resolveSubject } from "../../domain/authz/subjects.js";
import { resolveVisibleNodeIds } from "../../domain/authz/scope.js";
import { MAX_SCOPE_BUDGET } from "../../domain/authz/scopeSql.js";

export const authzRoutes = new Hono();

function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

authzRoutes.get("/visible-scope", async (c) => {
  try {
    const selfId = c.get("auth").userId;
    const targetUserId = (c.req.query("userId") ?? selfId).trim() || selfId;

    if (targetUserId !== selfId) {
      const actor = await resolveSubject(selfId, prisma);
      if (!actor.isWorkspaceOwner) {
        throw new HttpError(403, "查看他人可见集需要工作区管理权限（manage_share）");
      }
    }

    const actions = parseList(c.req.query("actions"));
    const kinds = parseList(c.req.query("kinds"));
    const budgetRaw = c.req.query("budget");
    let budget: number | undefined;
    if (budgetRaw !== undefined) {
      const n = Number(budgetRaw);
      if (!Number.isInteger(n) || n <= 0) {
        throw new HttpError(400, `budget 必须为正整数（硬上限 ${MAX_SCOPE_BUDGET}）`);
      }
      budget = n; // 域内 clampBudget 收敛到硬上限
    }

    const scope = await resolveVisibleNodeIds(prisma, targetUserId, { actions, kinds, budget });
    return c.json({
      userId: targetUserId,
      actions: actions ?? ["r"],
      kinds: kinds ?? null,
      nodeIds: scope.nodeIds,
      resourceIdsByType: scope.resourceIdsByType,
      maskedTableFields: scope.maskedTableFields,
      truncated: scope.truncated,
      policyVersion: scope.policyVersion,
      budget: scope.budget,
      evaluated: scope.evaluated,
      visibleTotal: scope.visibleTotal,
      materialize: scope.sql.expectsTempTable ? "temp_table" : "in_list",
      count: scope.nodeIds.length,
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // 域内非法动作等 Error 归一为 400，其余交全局 500（不泄漏内部细节）。
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("scope 不支持的动作")) throw new HttpError(400, msg);
    throw e;
  }
});
