// M4/S7 中断继承影响预览 + 写事务（计划 §4.5 EARS，AC-M4-2）。
//
// 纯 allow 集合运算，与 decide/scope 同口径：
//   现可见集 V_now  = cutoff 链（节点当前 inheritAncestors）上含 r 的三源授予展开；
//   关后 V_after    = 节点自身授予展开 ∪ 资源 creator ∪ workspace owner（§4.5 公式）；
//   losing          = ACTIVE(V_now) - ACTIVE(V_after)，creator/owner 移入 exempt 不计；
//   gaining（重开） = ACTIVE(V_after') - ACTIVE(V_now)，对称。
// 多部门/多角色只计 1（用户集去重）；items 分页但 count 精确；人数不含行级谓词（A-7）。
//
// 纯域：只依赖注入 client（tx 或全局），不 import Hono。

import type {
  InheritanceDeltaKind,
  InheritanceExemptItemDTO,
  InheritanceImpactDTO,
  InheritanceImpactItemDTO,
} from "@gx/shared-types";
import type { AuthzClient, AuthzNode } from "./types.js";
import { NavChainCache, navVersionOf } from "./nodes.js";
import { makeCreatedByResolver } from "./adapter.js";
import { GrantExpander, workspaceOwnerIds } from "./impactExpand.js";

/** 域内语义错误（不顶层 import guards——其连带 db 单例会在测试注入前求值；路由映射 HTTP）。 */
export class InheritanceError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InheritanceError";
  }
}

/** §4.5：仅 doc/canvas 叶子可切换继承；其他 kind 400 NODE_NOT_INHERITABLE。 */
export const INHERITABLE_KINDS = new Set(["doc", "canvas"]);

export const IMPACT_DEFAULT_LIMIT = 100;
export const IMPACT_MAX_LIMIT = 200;

/**
 * 纯函数：假设把 chain[0]（被决策节点自身）的 inheritAncestors 置为 target 后，
 * cutoff 链会收集哪些节点 id（叶->根序的 chain 输入；自身恒收集）。
 * target=0 -> 仅自身；target=1 -> 自身 + 向上到第一个 inheritAncestors=0 的祖先（含 K）。
 */
export function hypotheticalCollectIds(chain: readonly AuthzNode[], target: 0 | 1): string[] {
  if (chain.length === 0) return [];
  const ids = [chain[0]!.id];
  if (target === 1) {
    for (let i = 1; i < chain.length; i++) {
      ids.push(chain[i]!.id);
      if (chain[i]!.inheritAncestors === 0) break;
    }
  }
  return ids;
}

/** 取节点在某个 cutoff 节点 id 集上的含 r 授予（三源行，动作内存判）。 */
async function readGrantsOn(client: AuthzClient, nodeIds: string[]): Promise<Array<{ nodeId: string; subjectType: "user" | "dept" | "role"; subjectId: string }>> {
  if (nodeIds.length === 0) return [];
  const rows = await client.authPolicy.findMany({
    where: { nodeId: { in: nodeIds } },
    select: { nodeId: true, subjectType: true, subjectId: true, actions: true },
  });
  const out: Array<{ nodeId: string; subjectType: "user" | "dept" | "role"; subjectId: string }> = [];
  for (const r of rows) {
    if (!r.actions.split(",").map((s) => s.trim()).includes("r")) continue;
    if (r.subjectType === "user" || r.subjectType === "dept" || r.subjectType === "role") {
      out.push({ nodeId: r.nodeId, subjectType: r.subjectType, subjectId: r.subjectId });
    }
  }
  return out;
}

function viaOf(sources: ReadonlySet<string>): InheritanceImpactItemDTO["via"] {
  let hasDept = false;
  let hasRole = false;
  for (const s of sources) {
    if (s.startsWith("direct:")) return "direct";
    if (s.startsWith("dept:")) hasDept = true;
    else if (s.startsWith("role:")) hasRole = true;
  }
  return hasDept ? "dept" : hasRole ? "role" : "direct";
}

async function resolveNames(
  client: AuthzClient, userIds: readonly string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  for (let i = 0; i < userIds.length; i += 900) {
    const rows = await client.user.findMany({
      where: { id: { in: userIds.slice(i, i + 900) } },
      select: { id: true, displayName: true },
    });
    for (const r of rows) map.set(r.id, r.displayName);
  }
  return map;
}

function clampPagination(rawLimit: number | undefined, rawOffset: number | undefined): { limit: number; offset: number } {
  const limit = rawLimit === undefined
    ? IMPACT_DEFAULT_LIMIT
    : Math.min(Math.max(Math.trunc(rawLimit), 1), IMPACT_MAX_LIMIT);
  const offset = Math.max(Math.trunc(rawOffset ?? 0), 0);
  return { limit, offset };
}

export interface InheritanceImpactParams {
  /** 目标值：0=关继承（losing），1=重开（gaining）。 */
  target: 0 | 1;
  limit?: number;
  offset?: number;
}

/** 加载活可切换节点（软删 404，非 doc/canvas 400）。 */
export async function loadInheritableNode(client: AuthzClient, nodeId: string): Promise<AuthzNode> {
  const node = await client.navNode.findFirst({ where: { id: nodeId, deletedAt: null } });
  if (!node) throw new InheritanceError(404, "NODE_NOT_FOUND", "节点不存在或已删除");
  if (!INHERITABLE_KINDS.has(node.kind)) {
    throw new InheritanceError(400, "NODE_NOT_INHERITABLE", "仅文档/画布叶子节点可中断继承");
  }
  return node as AuthzNode;
}

/**
 * 影响预览（不开写事务）。count 精确（全量展开后去重），items 按 userId 字典序分页。
 * losing 时 creator/workspace owner 从失访集剔除并列入 exempt；gaining 时 exempt 为空。
 */
export async function inheritanceImpact(
  client: AuthzClient,
  nodeIdValue: string,
  params: InheritanceImpactParams,
): Promise<InheritanceImpactDTO> {
  const node = await loadInheritableNode(client, nodeIdValue);
  const { limit, offset } = clampPagination(params.limit, params.offset);
  const version = await navVersionOf(client);
  const cache = new NavChainCache();
  const chain = await cache.ancestorChain(client, nodeIdValue, version);
  const from = node.inheritAncestors === 1;
  const target = params.target;
  const delta: InheritanceDeltaKind = target === 0 ? "losing" : "gaining";

  const nowIds = hypotheticalCollectIds(chain, from ? 1 : 0);
  const afterIds = hypotheticalCollectIds(chain, target);

  const nowExpander = new GrantExpander(client);
  const nowSources = await nowExpander.expand(await readGrantsOn(client, nowIds));
  const afterExpander = new GrantExpander(client);
  const afterSources = await afterExpander.expand(await readGrantsOn(client, afterIds));

  // creator/workspace owner 兜底：与 decide 的 owner_fallback 同源。
  const createdBy = (await makeCreatedByResolver(client)(node)) ?? null;
  const ownerIds = await workspaceOwnerIds(client);

  const nowActive = await nowExpander.activeOnly(new Set(nowSources.keys()));
  // 先算"仅靠真实授予"的关后集，再叠加 creator/owner 兜底；exempt 只列
  // "授予侧已覆盖不到、仅因兜底才不失访"的主体（§4.5：creator/owner 失访时移 exempt 不计）。
  const afterGrantActive = await afterExpander.activeOnly(new Set(afterSources.keys()));
  const afterActive = new Set(afterGrantActive);
  if (createdBy) afterActive.add(createdBy);
  for (const o of ownerIds) afterActive.add(o);

  const affectedUserIds = new Set<string>();
  const exemptUserIds = new Set<string>();
  if (delta === "losing") {
    for (const id of nowActive) {
      if (!afterActive.has(id)) affectedUserIds.add(id);
      else if (!afterGrantActive.has(id) && (id === createdBy || ownerIds.has(id))) {
        exemptUserIds.add(id);
      }
    }
  } else {
    // gaining（重开）：仅算授予侧新覆盖的用户；creator/owner 关继承期间仍有兜底访问，
    // 不算"恢复"，从 gaining 集剔除（exempt 恒为空——关->开方向无失访豁免语义）。
    for (const id of afterGrantActive) {
      if (!nowActive.has(id) && id !== createdBy && !ownerIds.has(id)) affectedUserIds.add(id);
    }
  }

  const sorted = [...affectedUserIds].sort();
  const names = await resolveNames(client, [...sorted, ...exemptUserIds]);
  const items: InheritanceImpactItemDTO[] = sorted.slice(offset, offset + limit).map((userId) => ({
    userId,
    name: names.get(userId) ?? null,
    via: viaOf(nowSources.get(userId) ?? afterSources.get(userId) ?? new Set()),
    sources: [...(nowSources.get(userId) ?? afterSources.get(userId) ?? [])].sort(),
  }));
  const exempt: InheritanceExemptItemDTO[] = [...exemptUserIds].sort().map((userId) => ({
    userId,
    name: names.get(userId) ?? null,
    reason: userId === createdBy ? "creator" as const : "workspace_owner" as const,
  }));

  return {
    nodeId: nodeIdValue,
    from,
    to: target === 1,
    delta,
    count: sorted.length,
    items,
    limit,
    offset,
    exempt,
  };
}

export interface InheritanceChangeResult {
  nodeId: string;
  inheritAncestors: boolean;
  navVersion: number;
  policyVersion: number;
}

/** 写事务：置 inheritAncestors + 双版本 bump（navVersion 结构变 / policyVersion 决策输入变）。 */
export async function setInheritanceTx(
  tx: AuthzClient,
  nodeIdValue: string,
  target: 0 | 1,
): Promise<InheritanceChangeResult> {
  await tx.navNode.update({ where: { id: nodeIdValue }, data: { inheritAncestors: target } });
  const ws = await tx.workspace.update({
    where: { id: "ws_default" },
    data: { navVersion: { increment: 1 }, policyVersion: { increment: 1 } },
    select: { navVersion: true, policyVersion: true },
  });
  return {
    nodeId: nodeIdValue,
    inheritAncestors: target === 1,
    navVersion: ws.navVersion,
    policyVersion: ws.policyVersion,
  };
}
