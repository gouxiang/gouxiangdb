// M4/S4 visible-scope：在引擎侧一次性求某主体可见的 nav 节点集（M5 先收敛后召回的唯一入口，
// M6 同样消费）。
//
// 零分叉铁骨（M4 计划 §7-S4）：不另写一套"G∪子树−restricted"近似集合运算，而是把全量活节点
// 批量预取后，对每个节点复用与 engine.decide 完全相同的判定内核 evaluate.evaluateChainDecision
// （同一 cutoff / 两类 owner 兜底 / 动作命中）。inheritAncestors=0 的私密子树裁剪由此天然成立：
// 子节点链在 cutoff 边界 K 停止收集，K 自身无授予且其下无直接 allow 即 deny，无需 SQL 递归差集。
//
// 客体批量往返（与节点数/部门深度无关，区别于逐节点 decide 的每节点 3 往返）：
//   1) policiesForSubjectTx  三源候选策略一次取（不带 nodeId IN，规避 999 变量上限）；
//   2) navNode.findMany      工作区全部活节点一次取（应用层建链 + kind 过滤）；
//   3) creatorOwnedKeys      非 workspace-owner 时一条 UNION 取其创建的活资源（owner 全 allow 时跳过）；
//   4) workspace.findUnique  取 policyVersion 随响应回传（scope 不消费 navVersion，故不走 navVersionOf）。
// owner 主体跳过第 3 条 -> 3 条；非 owner 恰 4 条。
// 主体解析 resolveSubject 是与单节点 decide 共享的固定成本（≤4，深部门/多兼岗不增长），不计入客体批量。

import { RESOURCE_ACTIONS, normalizeActions, type ResourceAction } from "@gx/shared-types";
import { resolveSubject } from "./subjects.js";
import { policiesForSubjectTx } from "./repository.js";
import { buildChain, collectChainPolicies, evaluateChainDecision } from "./evaluate.js";
import { creatorOwnedKeys } from "./scopeCreators.js";
import { clampBudget, buildVisibleScopeSql, type VisibleScopeSql } from "./scopeSql.js";
import type { AuthzClient, AuthzNode, ResolvedSubject, ScopedPolicy } from "./types.js";

export type ScopeKind = "base" | "kb" | "table" | "view" | "doc" | "canvas" | "group";
const ALL_SCOPE_KINDS: readonly ScopeKind[] = ["base", "kb", "table", "view", "doc", "canvas", "group"];

export interface VisibleScope {
  /** 预算内有序可见节点 id（确定性：path,id 排序）。 */
  nodeIds: string[];
  /** 按资源类型归集的资源实体 id（nav.resourceId），便于 M5 直接 IN 实体表。 */
  resourceIdsByType: Record<string, string[]>;
  /** 结果是否在预算处被截断（截断时 M5 必须走临时表，禁止 IN 直拼）。 */
  truncated: boolean;
  policyVersion: number;
  /** 存在 fieldMask 收窄的 table 节点 -> 其来源 allowFields 白名单（缺省空数组=仅只读不裁可见；M5 消费）。 */
  maskedTableFields: Record<string, string[]>;
  /** 实际生效预算（经硬上限收敛）。 */
  budget: number;
  /** 诊断计数（不参与授权）：扫描活节点数 / 命中可见数（截断前）。 */
  evaluated: number;
  visibleTotal: number;
  /** 参数化 IN/临时表物化契约（§4.7，供 M5 直接消费）。 */
  sql: VisibleScopeSql;
}

export interface ResolveScopeOptions {
  actions?: string[];
  kinds?: string[];
  budget?: number;
  workspaceId?: string;
}

export interface PreparedScope {
  subject: ResolvedSubject;
  nodes: AuthzNode[];
  byId: Map<string, AuthzNode>;
  policiesByNode: Map<string, ScopedPolicy[]>;
  ownedKeys: Set<string> | null;
  policyVersion: number;
}

function normalizeKinds(raw: string[] | undefined): Set<ScopeKind> | null {
  if (!raw || raw.length === 0) return null; // 缺省 = 全部资源类型
  const allow = new Set<string>(ALL_SCOPE_KINDS);
  const out = new Set<ScopeKind>();
  for (const k of raw) {
    const t = k.trim();
    if (allow.has(t)) out.add(t as ScopeKind);
  }
  return out;
}

/**
 * 预取一次 scope 判定所需全部数据（主体 + 候选策略 + 活节点 + creator 集 + policyVersion）。
 * 客体 4 条（非 owner：策略/节点/creator UNION/workspace；owner 跳过 creator 为 3 条）。
 */
export async function prepareScope(
  client: AuthzClient,
  userId: string,
  opts: ResolveScopeOptions = {},
): Promise<PreparedScope> {
  const workspaceId = opts.workspaceId ?? "ws_default";
  const subject = await resolveSubject(userId, client);
  const policies = await policiesForSubjectTx(client, subject, workspaceId);
  const nodes = await client.navNode.findMany({
    where: { workspaceId, deletedAt: null },
    select: {
      id: true, workspaceId: true, parentId: true, kind: true, resourceType: true, resourceId: true,
      name: true, path: true, depth: true, inheritAncestors: true, deletedAt: true,
    },
  }) as unknown as AuthzNode[];

  const policiesByNode = new Map<string, ScopedPolicy[]>();
  for (const p of policies) {
    const list = policiesByNode.get(p.nodeId);
    if (list) list.push(p);
    else policiesByNode.set(p.nodeId, [p]);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ownedKeys = subject.isWorkspaceOwner ? null : await creatorOwnedKeys(client, userId);
  // scope 响应回传 policyVersion（策略写 bump 的那一列），不读 navVersion（scope 不用链缓存）。
  const ws = await client.workspace.findUnique({
    where: { id: workspaceId },
    select: { policyVersion: true },
  });
  const policyVersion = ws?.policyVersion ?? 0;

  return { subject, nodes, byId, policiesByNode, ownedKeys, policyVersion };
}

/** 纯计算：在已预取数据上判定单节点对某动作是否可见（与 decide 同内核）。 */
export function nodeVisibleInPrepared(prepared: PreparedScope, node: AuthzNode, action: ResourceAction): boolean {
  const chain = buildChain(node, prepared.byId);
  if (chain.length === 0 || chain[0]!.id !== node.id) return false; // 自节点缺失防御
  const policies = collectChainPolicies(chain, prepared.policiesByNode);
  const isCreator = prepared.ownedKeys !== null
    && !!node.resourceType && !!node.resourceId
    && prepared.ownedKeys.has(`${node.resourceType}:${node.resourceId}`);
  return evaluateChainDecision({
    subject: prepared.subject, node, chain, policies, action, isCreator,
  }).allowed;
}

function collectMaskedTableFields(
  visible: AuthzNode[],
  prepared: PreparedScope,
  action: ResourceAction,
): Record<string, string[]> {
  if (action !== "r") return {}; // fieldMask 可见性裁剪仅对读动作有意义
  const out: Record<string, string[]> = {};
  for (const node of visible) {
    if (node.resourceType !== "table") continue;
    const chain = buildChain(node, prepared.byId);
    const policies = collectChainPolicies(chain, prepared.policiesByNode);
    const masks = policies
      .filter((p) => p.actions.includes("r") && p.fieldMask && p.fieldMask.allowFields)
      .map((p) => p.fieldMask!.allowFields!);
    if (masks.length > 0) out[node.id] = [...new Set(masks.flat())];
  }
  return out;
}

/**
 * 求可见集。动作默认 ['r']（多动作取并：节点对任一动作可见即纳入）；kinds 缺省为全部资源类型；
 * budget 默认 5000、硬上限 20000，超出截断并在 sql 契约置 expectsTempTable。
 */
export async function resolveVisibleNodeIds(
  client: AuthzClient,
  userId: string,
  opts: ResolveScopeOptions = {},
): Promise<VisibleScope> {
  const rawActions = opts.actions ?? ["r"];
  // 先对原始 token 白名单校验（normalizeActions 会静默丢弃非法值，端点须 fail-closed 报 400）。
  for (const raw of rawActions) {
    const a = raw.trim();
    if (a && !(RESOURCE_ACTIONS as readonly string[]).includes(a)) {
      throw new Error(`scope 不支持的动作: ${a}`);
    }
  }
  const actions = normalizeActions(rawActions);
  if (actions.length === 0) actions.push(...(["r"] as ResourceAction[]));
  const kindFilter = normalizeKinds(opts.kinds);
  const budget = clampBudget(opts.budget);

  const prepared = await prepareScope(client, userId, { ...opts, budget });

  const candidates = prepared.nodes.filter(
    (n) => n.resourceType !== null && (!kindFilter || (n.resourceType && kindFilter.has(n.resourceType as ScopeKind))),
  );

  const visible: AuthzNode[] = [];
  for (const node of candidates) {
    if (actions.some((a) => nodeVisibleInPrepared(prepared, node, a))) visible.push(node);
  }
  // 确定性排序（path 主键、id 兜底），保证截断与 IN 顺序可复现。
  visible.sort((a, b) => (a.path === b.path ? a.id.localeCompare(b.id) : a.path.localeCompare(b.path)));

  const visibleTotal = visible.length;
  const truncated = visible.length > budget;
  const inBudget = truncated ? visible.slice(0, budget) : visible;

  const resourceIdsByType: Record<string, string[]> = {};
  for (const n of inBudget) {
    if (!n.resourceType || !n.resourceId) continue;
    (resourceIdsByType[n.resourceType] ??= []).push(n.resourceId);
  }
  const maskedTableFields = actions.includes("r" as ResourceAction)
    ? collectMaskedTableFields(inBudget, prepared, "r")
    : {};
  const nodeIds = inBudget.map((n) => n.id);

  return {
    nodeIds,
    resourceIdsByType,
    truncated,
    policyVersion: prepared.policyVersion,
    maskedTableFields,
    budget,
    evaluated: candidates.length,
    visibleTotal,
    sql: buildVisibleScopeSql(nodeIds, truncated),
  };
}
