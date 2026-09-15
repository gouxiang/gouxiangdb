// M4/S1 决策引擎（纯 allow，无 deny 分支；本切片无任何调用方，不接线、不改 guards/config）。
//
// 确定性优先级（ARCH §5.2 / 计划 §4.3）：
//   实体 createdBy 兜底 -> workspace role_owner 兜底 -> 节点直接 allow
//   ->（inheritAncestors=1 时）cutoff 内祖先 allow 并集 -> 无 allow 即拒。
// 纯域：只依赖注入 client（nav_nodes/workspaces/auth_policies）与注入的 createdBy 解析器，
// 不 import Hono/guards，不查 members/kb_members/kb_doc_acls。

import type { ResourceAction } from "@gx/shared-types";
import { collectibleChainIndexes, NavChainCache, navVersionOf } from "./nodes.js";
import { policiesOnNodesTx } from "./repository.js";
import { fieldCapability, fieldVisibleInMask, fieldWritableInMask, type FieldCapability } from "./fieldMask.js";
import type {
  AllowSource,
  AuthzClient,
  AuthzNode,
  CreatedByResolver,
  Decision,
  DecisionContext,
  ResolvedSubject,
  ScopedPolicy,
} from "./types.js";

export interface EngineDeps {
  client: AuthzClient;
  cache?: NavChainCache;
  /** 缺省每次决策取 workspaces.navVersion（计 1 往返）；调用方可预取传入做批量复用。 */
  navVersion?: number;
  workspaceId?: string;
  /** 实体 createdBy 解析（S3 适配层按 resourceType 点查并可自带缓存）；缺省不做 creator 兜底。 */
  resolveCreatedBy?: CreatedByResolver | null;
}

/** 一次决策的完整产物（capability 是收集的副产物，不新增往返，供出口投影）。 */
export interface DecisionResult {
  decision: Decision;
  node: AuthzNode;
  chain: AuthzNode[];
  /** cutoff 内去重后的全部命中策略（含未承载该动作的来源，fieldCapability 据此算字段并集）。 */
  policies: ScopedPolicy[];
  capability: FieldCapability;
}

function sourceOf(p: ScopedPolicy, chain: AuthzNode[]): AllowSource {
  const node = chain.find((n) => n.id === p.nodeId);
  return {
    kind: p.subjectType === "user" ? "direct" : p.subjectType,
    policyId: p.id,
    nodeId: p.nodeId,
    nodeName: node?.name,
    viaAncestor: p.nodeId !== chain[0]?.id,
    subjectId: p.subjectType === "user" ? undefined : p.subjectId,
  };
}

function fieldPasses(p: ScopedPolicy, action: ResourceAction, ctx?: DecisionContext): boolean {
  if (!ctx?.fieldId) return true;
  const mask = p.fieldMask;
  if (action === "r") return fieldVisibleInMask(mask, ctx.fieldId);
  if (action === "c" || action === "u") return fieldWritableInMask(mask, ctx.fieldId);
  return true; // d/comment/manage_* 不做字段裁剪
}

async function resolveVersion(deps: EngineDeps): Promise<number> {
  if (deps.navVersion !== undefined) return deps.navVersion;
  return navVersionOf(deps.client, deps.workspaceId ?? "ws_default");
}

/**
 * 收集单节点 cutoff 内全部命中策略（去重 by policyId，按 chain 序：自身 -> 祖先）。
 * 客体往返：节点点查 1 + 链批量 1（缓存命中链时为 0）+ 策略行 1。
 */
export async function collectScopedNodes(
  deps: EngineDeps,
  subject: ResolvedSubject,
  nodeId: string,
): Promise<{ policies: ScopedPolicy[]; chain: AuthzNode[]; node: AuthzNode }> {
  const cache = deps.cache ?? new NavChainCache();
  const version = await resolveVersion(deps);
  const chain = await cache.ancestorChain(deps.client, nodeId, version);
  const node = chain[0];
  if (!node) throw new Error("NAV_NODE_NOT_FOUND");

  const indexes = collectibleChainIndexes(chain);
  const wantedIds = indexes.map((i) => chain[i]!.id);
  const rows = await policiesOnNodesTx(deps.client, wantedIds, subject);

  const byId = new Map<string, ScopedPolicy>();
  for (const nid of wantedIds) {
    for (const row of rows) {
      if (row.nodeId !== nid || byId.has(row.id)) continue;
      byId.set(row.id, { ...row, viaAncestor: nid !== node.id });
    }
  }
  return { policies: [...byId.values()], chain, node };
}

function fallbackDecision(node: AuthzNode, fallback: "workspace_owner" | "creator"): Decision {
  return {
    allowed: true,
    action: "r", // 由 decide 覆盖为实际动作
    nodeId: node.id,
    sources: [{ kind: "owner_fallback", nodeId: node.id, nodeName: node.name, viaAncestor: false, fallback }],
  };
}

/**
 * 单节点决策。动作命中的来源全部列入 sources（O8 来源链，多源并集可解释）；
 * conditions M4 恒 null（非空写入已被 API 拦），此处留口不做行级求值。
 */
export async function decide(
  deps: EngineDeps,
  subject: ResolvedSubject,
  nodeId: string,
  action: ResourceAction,
  ctx?: DecisionContext,
): Promise<DecisionResult> {
  const { policies, chain, node } = await collectScopedNodes(deps, subject, nodeId);
  const capability = fieldCapability(policies);

  if (deps.resolveCreatedBy) {
    const creator = await deps.resolveCreatedBy(node);
    if (creator && creator === subject.userId) {
      const d = { ...fallbackDecision(node, "creator"), action };
      return { decision: d, node, chain, policies, capability };
    }
  }
  if (subject.isWorkspaceOwner) {
    const d = { ...fallbackDecision(node, "workspace_owner"), action };
    return { decision: d, node, chain, policies, capability };
  }

  const sources = policies
    .filter((p) => p.actions.includes(action))
    .filter((p) => fieldPasses(p, action, ctx))
    .map((p) => sourceOf(p, chain));

  const decision: Decision = sources.length
    ? { allowed: true, action, nodeId: node.id, sources }
    : { allowed: false, action, nodeId: node.id, sources: [], reason: "no_matching_allow" };
  return { decision, node, chain, policies, capability };
}

/** 批量决策：主体/版本/缓存复用，客体每节点一条链（链缓存共享）+ 策略按节点各一条。 */
export async function decideMany(
  deps: EngineDeps,
  subject: ResolvedSubject,
  nodeIds: readonly string[],
  action: ResourceAction,
  ctx?: DecisionContext,
): Promise<DecisionResult[]> {
  const shared: EngineDeps = { ...deps, cache: deps.cache ?? new NavChainCache() };
  const out: DecisionResult[] = [];
  for (const id of nodeIds) {
    out.push(await decide(shared, subject, id, action, ctx));
  }
  return out;
}
