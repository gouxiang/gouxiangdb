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

/**
 * creator 兜底【不覆盖】的纯组织管理动作。
 *
 * manage_table（表重命名/删表/清空/回收站/可见行配置入口）是纯组织管理权，只来自
 * 「角色 × role_library_scope」的 canManage——资源 owner 的动作串（ADR-0039 §2.2：
 * r,c,u,d,comment + manage_share，base owner 另有 manage_schema）里【本就没有
 * manage_table】。故建库/建表后即使把创建人降权（摘下管理权），他也不得再凭
 * "东西是我建的"拿回 manage_table，否则一旦授权后被收回，收权永久失效。
 *
 * 注意：manage_schema 不在此列。创建人对自己资源保留结构设计权（ADR-0039 §2.2
 * 明示 base owner 另有 manage_schema；MCP field/view/table 写工具据此向创建者放行）。
 * 内容级动作（r/c/u/d/comment/share_link/enter）同样由 creator 兜底承载。
 */
const ADMIN_ACTIONS: ReadonlySet<ResourceAction> = new Set<ResourceAction>([
  "manage_table",
]);

/**
 * 管理员系统角色锚点（= org/roles.SYSTEM_ROLES 里的 role_admin）。
 * 本文件是纯域（禁止 import 带 prisma 的 org/roles），故本地锚定同一字面量，
 * 与 scopeBackfill.ts 本地锚定 SUPER_ADMIN_ROLE_ID 的做法一致。
 */
const ADMIN_ROLE_ID = "role_admin";

/**
 * 管理员「库门」角色级兜底：仅对 base/kb 节点的 enter 成立。
 *
 * 为什么必须在引擎里兜（而不只靠物化投影）：role_admin 对全部活库的 enter 隐含授权
 * （implicitAdminProject F8 强制 visible=true）本是「天然能进全部库」的硬规则，但它只在
 * 建库/建表/scope PUT 三个【写路径】物化进 auth_policies；双写上线前的存量库从未投影
 * （迁移 20260921020000 只回填 role_library_scope 台账、不灌 auth_policies），一旦漏投影，
 * 管理员点老库即被引擎以 no_matching_allow 拒之门外（403）。库门准入不应依赖数据是否补齐，
 * 故在判定内核按角色硬兜，与超管 isWorkspaceOwner 兜底同性质。
 *
 * 红线（越权边界，缺一不可）：
 *   - 只兜 enter 这一枚「库门准入位」；绝不兜内容动作 r/c/u/d/comment——库节点补内容位会
 *     绕过 table 节点的逐表 fieldMask 收窄（§1.3 已否决的「库节点补 r」f2 泄漏口）；
 *   - 绝不兜 edit_data/manage_table/manage_schema/manage_share——管理权只来自
 *     role_library_scope(canManage) 的物化投影，无投影即只读进门，不凭空放大；
 *   - 绝不兜 d——删库另有 requireCanDeleteBase conjunction 硬规则，仅超级管理员可删。
 * 内容读与管理权仍由 policies 物化投影裁决（见 evaluateChainDecision 后半段）。
 */
function adminLibraryEnterFallback(
  subject: ResolvedSubject,
  node: AuthzNode,
  action: ResourceAction,
): Decision | null {
  if (action !== "enter") return null;
  if (!subject.roleIds.includes(ADMIN_ROLE_ID)) return null;
  if (node.resourceType !== "base" && node.resourceType !== "kb") return null;
  return {
    allowed: true,
    action,
    nodeId: node.id,
    // 角色来源（非 owner_fallback）：可解释为「管理员系统角色隐含的库门准入」，
    // subjectId 锚定 role_admin，供 policyQuery 解析为角色名。
    sources: [{
      kind: "role",
      nodeId: node.id,
      nodeName: node.name,
      viaAncestor: false,
      subjectId: ADMIN_ROLE_ID,
    }],
  };
}

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
  // creator 兜底只承载内容所有权，不覆盖纯组织/结构管理动作（见 ADMIN_ACTIONS）。
  if (isCreator && !ADMIN_ACTIONS.has(action)) return fallbackDecision(node, "creator", action);
  if (subject.isWorkspaceOwner) return fallbackDecision(node, "workspace_owner", action);
  // 管理员库门兜底：仅 base/kb 的 enter（天然进全部库），不放大内容读/管理权/删库（见函数注释）。
  const adminEnter = adminLibraryEnterFallback(subject, node, action);
  if (adminEnter) return adminEnter;

  const sources = policies
    .filter((p) => p.actions.includes(action))
    .filter((p) => fieldPasses(p, action, ctx))
    .map((p) => sourceOf(p, chain));

  return sources.length
    ? { allowed: true, action, nodeId: node.id, sources }
    : { allowed: false, action, nodeId: node.id, sources: [], reason: "no_matching_allow" };
}
