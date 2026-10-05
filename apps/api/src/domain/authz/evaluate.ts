// M4/S4 决策判定纯内核（无 IO）：把 engine.decide 的"链 + cutoff 内策略 + 两类兜底 -> Decision"
// 抽成纯函数，供单节点 decide（实时点查）与 scope（批量预取后逐节点内存判定）共用同一条代码路径，
// 从结构上保证 scope 快路径与逐节点 decide 语义零分叉（M4 计划 §7-S4 硬约束）。
//
// 纯域：不 import Hono/guards/db，不读任何表；输入全部由调用方预取。

import type { ResourceAction } from "@gx/shared-types";
import { collectibleChainIndexes } from "./nodes.js";
import { fieldVisibleInMask, fieldWritableInMask } from "./fieldMask.js";
import type {
  AllowSource,
  AuthzNode,
  Decision,
  DecisionContext,
  ResolvedSubject,
  ScopedPolicy,
} from "./types.js";

/** 由全量活节点索引构建目标节点的祖先链（叶->根，chain[0]=自身）；缺失段容错跳过。 */
export function buildChain(target: AuthzNode, byId: ReadonlyMap<string, AuthzNode>): AuthzNode[] {
  const ids = target.path.split("/").filter(Boolean).reverse();
  const chain: AuthzNode[] = [];
  for (const id of ids) {
    const n = byId.get(id);
    if (n) chain.push(n);
  }
  return chain;
}

/**
 * 从按节点分组的候选策略中，收集某条链 cutoff 内去重后的策略（按链序：自身 -> 祖先）。
 * 与 engine.collectScopedNodes 的内存段完全同口径（含 viaAncestor 标注）。
 */
export function collectChainPolicies(
  chain: readonly AuthzNode[],
  policiesByNode: ReadonlyMap<string, ScopedPolicy[]>,
): ScopedPolicy[] {
  const indexes = collectibleChainIndexes(chain);
  const selfId = chain[0]?.id;
  const byPolicyId = new Map<string, ScopedPolicy>();
  for (const i of indexes) {
    const nid = chain[i]!.id;
    for (const row of policiesByNode.get(nid) ?? []) {
      if (byPolicyId.has(row.id)) continue;
      byPolicyId.set(row.id, { ...row, viaAncestor: nid !== selfId });
    }
  }
  return [...byPolicyId.values()];
}

function sourceOf(p: ScopedPolicy, chain: readonly AuthzNode[]): AllowSource {
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

function fallbackDecision(node: AuthzNode, fallback: "workspace_owner" | "creator", action: ResourceAction): Decision {
  return {
    allowed: true,
    action,
    nodeId: node.id,
    sources: [{ kind: "owner_fallback", nodeId: node.id, nodeName: node.name, viaAncestor: false, fallback }],
  };
}

interface ChainEvaluationInput {
  subject: ResolvedSubject;
  node: AuthzNode;
  chain: AuthzNode[];
  /** cutoff 内去重后的候选策略（collectChainPolicies 产物）。 */
  policies: ScopedPolicy[];
  action: ResourceAction;
  ctx?: DecisionContext;
  /** 实体 createdBy 兜底：该节点资源由当前主体创建（调用方批量预取 creator 集合后判定）。 */
  isCreator: boolean;
}

/**
 * 单节点纯判定：creator 兜底 -> workspace owner 兜底 -> 动作命中策略 -> 无 allow 即拒。
 * decide 与 scope 共用本函数，禁止两处各写一份判定。
 */
export function evaluateChainDecision(input: ChainEvaluationInput): Decision {
  const { subject, node, chain, policies, action, ctx, isCreator } = input;
  if (isCreator) return fallbackDecision(node, "creator", action);
  if (subject.isWorkspaceOwner) return fallbackDecision(node, "workspace_owner", action);

  const sources = policies
    .filter((p) => p.actions.includes(action))
    .filter((p) => fieldPasses(p, action, ctx))
    .map((p) => sourceOf(p, chain));

  return sources.length
    ? { allowed: true, action, nodeId: node.id, sources }
    : { allowed: false, action, nodeId: node.id, sources: [], reason: "no_matching_allow" };
}
