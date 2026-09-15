// M4/S7 中断继承端点（计划 §4.5/§7-S7，AC-M4-2）+ A-6 面包屑端点。
//
// GET   /nodes/:id/inheritance/impact?value=0|1&limit=&offset=  失访/恢复预览（manage_share）
// PATCH /nodes/:id/inheritance {value:false, confirmed:true}    双版本 bump + 审计（manage_share）
// GET   /nodes/:id/breadcrumb                                   本人 r 可见段 + 中性截断标记
//
// 薄控制器：只做参数解析/授权/审计/信封；集合运算在 domain/authz/inheritance 与 breadcrumb。
// 未确认 PATCH -> 409 INHERITANCE_CONFIRM_REQUIRED 且回带 impact（与 move 同款交互）。
// 非 doc/canvas 叶子 -> 400 NODE_NOT_INHERITABLE；错误沿用 {error,code} 信封。

import { Hono } from "hono";
import { prisma, withWriteTx } from "../../db.js";
import { audit } from "../../audit/emit.js";
import { HttpError } from "../../guards.js";
import { canManageNodeShare } from "../../domain/authz/policyAccess.js";
import {
  inheritanceImpact,
  loadInheritableNode,
  setInheritanceTx,
  InheritanceError,
} from "../../domain/authz/inheritance.js";
import { visibleBreadcrumb } from "../../domain/authz/breadcrumb.js";

export const inheritanceRoutes = new Hono();

function mapInheritanceError(e: unknown): never {
  if (e instanceof InheritanceError) throw new HttpError(e.status, e.message, e.code);
  throw e;
}

/** value 查询参数 -> 0|1；非法 400。 */
function parseTargetValue(raw: string | undefined, current: boolean): 0 | 1 {
  if (raw === undefined) return current ? 0 : 1; // 缺省 = 切换到当前值的反面
  if (raw === "0" || raw === "false") return 0;
  if (raw === "1" || raw === "true") return 1;
  throw new HttpError(400, "value 只能是 0 或 1", "BAD_REQUEST");
}

inheritanceRoutes.get("/:id/inheritance/impact", async (c) => {
  const actorId = c.get("auth").userId;
  const nodeId = c.req.param("id")!;
  let node: Awaited<ReturnType<typeof loadInheritableNode>>;
  try {
    node = await loadInheritableNode(prisma, nodeId);
  } catch (e) {
    mapInheritanceError(e);
  }
  if (!(await canManageNodeShare(actorId, nodeId))) {
    throw new HttpError(403, "无权预览该节点的继承影响（需 manage_share）");
  }
  const target = parseTargetValue(c.req.query("value"), node.inheritAncestors === 1);
  const limit = c.req.query("limit") !== undefined ? Number(c.req.query("limit")) : undefined;
  const offset = c.req.query("offset") !== undefined ? Number(c.req.query("offset")) : undefined;
  if ((limit !== undefined && !Number.isInteger(limit)) || (offset !== undefined && !Number.isInteger(offset))) {
    throw new HttpError(400, "limit/offset 必须为整数", "BAD_REQUEST");
  }
  try {
    const impact = await prisma.$transaction((tx) =>
      inheritanceImpact(tx, nodeId, { target, limit, offset }));
    return c.json(impact);
  } catch (e) {
    mapInheritanceError(e);
  }
});

inheritanceRoutes.patch("/:id/inheritance", async (c) => {
  const actorId = c.get("auth").userId;
  const nodeId = c.req.param("id")!;
  const body = await c.req.json().catch(() => null) as { value?: unknown; confirmed?: unknown } | null;
  if (!body || typeof body.value !== "boolean") {
    throw new HttpError(400, "请求体必须为 {value: boolean, confirmed?: boolean}", "BAD_REQUEST");
  }
  const target: 0 | 1 = body.value ? 1 : 0;

  let node;
  try {
    node = await loadInheritableNode(prisma, nodeId);
  } catch (e) {
    mapInheritanceError(e);
  }
  if (!(await canManageNodeShare(actorId, nodeId))) {
    throw new HttpError(403, "无权切换该节点继承（需 manage_share）");
  }

  const impact = await prisma.$transaction((tx) => inheritanceImpact(tx, nodeId, { target }));

  // 幂等：目标值与现状一致时直接回当前版本状态（count=0），不 bump、不审计。
  if (node.inheritAncestors === target) {
    const ws = await prisma.workspace.findUniqueOrThrow({
      where: { id: "ws_default" },
      select: { navVersion: true, policyVersion: true },
    });
    return c.json({
      nodeId,
      inheritAncestors: target === 1,
      navVersion: ws.navVersion,
      policyVersion: ws.policyVersion,
      impact,
    });
  }

  if (body.confirmed !== true) {
    return c.json(
      { error: "切换继承将影响上述成员访问，需确认后执行", code: "INHERITANCE_CONFIRM_REQUIRED", impact },
      409,
    );
  }

  const result = await withWriteTx("authz.inheritance.set", (tx) => setInheritanceTx(tx, nodeId, target));
  audit(c, {
    event: "inheritance_changed",
    status: 200,
    actorId,
    detail: {
      nodeId,
      nodeKind: node.kind,
      from: impact.from,
      to: impact.to,
      delta: impact.delta,
      count: impact.count,
    },
  });
  return c.json({ ...result, impact });
});

inheritanceRoutes.get("/:id/breadcrumb", async (c) => {
  const actorId = c.get("auth").userId;
  const nodeId = c.req.param("id")!;
  const result = await visibleBreadcrumb(prisma, actorId, nodeId);
  if (result === null) throw new HttpError(404, "节点不存在或已删除", "NODE_NOT_FOUND");
  if (result === "forbidden") throw new HttpError(403, "无权查看该节点");
  return c.json(result);
});
