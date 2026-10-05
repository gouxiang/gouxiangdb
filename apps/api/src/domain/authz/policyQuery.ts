// M4/S5 节点策略只读查询域：列节点策略（含继承态/祖先只读摘要）+ effective 决策解释器。
//
// 纯域：只依赖注入 client，不 import Hono/guards/db 单例。
//   - listNodePolicies 是【管理视角】：展示该节点上的全部策略行（不限主体），并据 cutoff 祖先链
//     给出会向下继承的祖先只读策略摘要（链长有界，通常 <=6）。
//   - explainEffective 是【主体视角】：对某用户跑七枚资源动作的 decide（与 scope/守卫同引擎，
//     禁止第二套判定），汇总最终动作集与每动作完整来源链（O8 可解释）。

import {
  RESOURCE_ACTIONS,
  parseActionString,
  type FieldMask,
  type ResourceAction,
} from "@gx/shared-types";
import { decide, type EngineDeps } from "./engine.js";
import { collectibleChainIndexes, NavChainCache, navVersionOf } from "./nodes.js";
import { resolveSubject } from "./subjects.js";
import type { AllowSource, AuthzClient, AuthzNode } from "./types.js";

type SubjectType = "user" | "dept" | "role";

interface NamedSubject {
  subjectType: SubjectType;
  subjectId: string;
  /** user=displayName，role/dept=name；查不到（悬挂）为 null。 */
  subjectName: string | null;
}

/** 批量解析三源主体显示名（3 条定数查询，去重后 IN）。 */
async function resolveNames(
  client: AuthzClient,
  refs: ReadonlySet<string>,
): Promise<Map<string, string | null>> {
  const users = new Set<string>();
  const roles = new Set<string>();
  const depts = new Set<string>();
  for (const ref of refs) {
    const i = ref.indexOf(":");
    const type = ref.slice(0, i) as SubjectType;
    const id = ref.slice(i + 1);
    if (type === "user") users.add(id);
    else if (type === "role") roles.add(id);
    else depts.add(id);
  }
  const out = new Map<string, string | null>();
  if (users.size) {
    const rows = await client.user.findMany({
      where: { id: { in: [...users] } }, select: { id: true, displayName: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.displayName]));
    for (const id of users) out.set(`user:${id}`, byId.get(id) ?? null);
  }
  if (roles.size) {
    const rows = await client.role.findMany({
      where: { id: { in: [...roles] } }, select: { id: true, name: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    for (const id of roles) out.set(`role:${id}`, byId.get(id) ?? null);
  }
  if (depts.size) {
    const rows = await client.department.findMany({
      where: { id: { in: [...depts] } }, select: { id: true, name: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    for (const id of depts) out.set(`dept:${id}`, byId.get(id) ?? null);
  }
  return out;
}

function parseMask(raw: string | null): FieldMask | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" ? (v as FieldMask) : null;
  } catch {
    return null;
  }
}

interface NodePolicyRow extends NamedSubject {
  id: string;
  actions: string[];
  fieldMask: FieldMask | null;
  reason: string | null;
  createdAt: string;
}

interface AncestorPolicySummary {
  nodeId: string;
  nodeName: string;
  policies: Array<NamedSubject & { actions: string[] }>;
}

export interface NodePoliciesView {
  node: { id: string; kind: string; resourceType: string | null; name: string; inheritAncestors: number };
  inheritAncestors: boolean;
  direct: NodePolicyRow[];
  ancestors: AncestorPolicySummary[];
}

/** 管理视角：节点全部直接策略行 + cutoff 内祖先只读继承摘要。 */
export async function listNodePolicies(client: AuthzClient, nodeId: string): Promise<NodePoliciesView> {
  const version = await navVersionOf(client);
  const cache = new NavChainCache();
  const chain = await cache.ancestorChain(client, nodeId, version);
  const self = chain[0];
  if (!self) throw new Error("NAV_NODE_NOT_FOUND");

  const indexes = collectibleChainIndexes(chain);
  const collectIds = indexes.map((i) => chain[i]!.id);
  const rows = await client.authPolicy.findMany({
    where: { nodeId: { in: collectIds } },
    orderBy: [{ subjectType: "asc" }, { subjectId: "asc" }],
  });

  const nameRefs = new Set<string>();
  for (const r of rows) nameRefs.add(`${r.subjectType}:${r.subjectId}`);
  const names = await resolveNames(client, nameRefs);

  const direct: NodePolicyRow[] = [];
  const byAncestor = new Map<string, AuthzNode>();
  for (const i of indexes) {
    if (i === 0) continue;
    byAncestor.set(chain[i]!.id, chain[i]!);
  }
  const ancestorRows = new Map<string, Array<NamedSubject & { actions: string[] }>>();

  for (const r of rows) {
    const st = r.subjectType as SubjectType;
    const named: NamedSubject = {
      subjectType: st, subjectId: r.subjectId, subjectName: names.get(`${st}:${r.subjectId}`) ?? null,
    };
    if (r.nodeId === self.id) {
      direct.push({
        ...named, id: r.id, actions: parseActionString(r.actions),
        fieldMask: parseMask(r.fieldMask), reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      });
    } else if (byAncestor.has(r.nodeId)) {
      const list = ancestorRows.get(r.nodeId) ?? [];
      list.push({ ...named, actions: parseActionString(r.actions) });
      ancestorRows.set(r.nodeId, list);
    }
  }

  const ancestors: AncestorPolicySummary[] = [];
  for (const i of indexes) {
    if (i === 0) continue;
    const n = chain[i]!;
    const policies = ancestorRows.get(n.id) ?? [];
    if (policies.length) ancestors.push({ nodeId: n.id, nodeName: n.name, policies });
  }

  return {
    node: {
      id: self.id, kind: self.kind, resourceType: self.resourceType,
      name: self.name, inheritAncestors: self.inheritAncestors,
    },
    inheritAncestors: self.inheritAncestors === 1,
    direct,
    ancestors,
  };
}

interface EffectiveSource extends NamedSubject {
  kind: AllowSource["kind"];
  policyId: string | null;
  nodeId: string;
  nodeName: string | null;
  viaAncestor: boolean;
  fallback: "workspace_owner" | "creator" | null;
}

export interface EffectiveView {
  node: { id: string; kind: string; resourceType: string | null; name: string };
  userId: string;
  actions: ResourceAction[];
  policyVersion: number;
  perAction: Array<{ action: ResourceAction; allowed: boolean; sources: EffectiveSource[] }>;
}

/** 主体视角：对七枚资源动作逐一 decide，汇总最终动作集与来源链（含主体名解析）。 */
export async function explainEffective(
  client: AuthzClient,
  targetUserId: string,
  nodeId: string,
  deps: Pick<EngineDeps, "resolveCreatedBy">,
): Promise<EffectiveView> {
  const subject = await resolveSubject(targetUserId, client);
  const version = await navVersionOf(client);
  const engineDeps: EngineDeps = { client, navVersion: version, ...deps };

  // 先跑一次拿到节点（decide 内部按动作重复，用缓存链 0 额外点查）。
  const first = await decide(engineDeps, subject, nodeId, "r");
  const cache = new NavChainCache();
  const shared: EngineDeps = { ...engineDeps, cache };

  // 库节点只呈现其合法位：base = enter/edit_data/manage_*，kb = enter/manage_share/manage_table；
  // 内容节点（table/doc/canvas/view）枚举全部 10 枚。库节点不呈现内容动作 r/c/u/d/comment。
  const libType = first.node.resourceType === "base" || first.node.resourceType === "kb";
  const actionsToRun = RESOURCE_ACTIONS.filter((a) => {
    if (!libType) return true;
    if (a === "enter" || a === "edit_data") {
      return first.node.resourceType === "base" || a === "enter";
    }
    if (a === "manage_schema") return first.node.resourceType === "base";
    if (a === "r" || a === "c" || a === "u" || a === "d" || a === "comment") return false;
    return true;
  });

  const nameRefs = new Set<string>();
  const perAction: EffectiveView["perAction"] = [];
  for (const action of actionsToRun) {
    const result = action === "r" ? first : await decide(shared, subject, nodeId, action);
    for (const s of result.decision.sources) {
      if (s.kind === "direct") nameRefs.add(`user:${targetUserId}`);
      else if (s.subjectId) nameRefs.add(`${s.kind}:${s.subjectId}`);
    }
    perAction.push({
      action,
      allowed: result.decision.allowed,
      sources: result.decision.sources.map((s) => ({
        subjectType: (s.kind === "direct" ? "user" : s.kind === "owner_fallback" ? "user" : s.kind) as SubjectType,
        subjectId: s.kind === "direct" || s.kind === "owner_fallback" ? targetUserId : (s.subjectId ?? ""),
        subjectName: null,
        kind: s.kind,
        policyId: s.policyId ?? null,
        nodeId: s.nodeId,
        nodeName: s.nodeName ?? null,
        viaAncestor: s.viaAncestor,
        fallback: s.fallback ?? null,
      })),
    });
  }

  const names = await resolveNames(client, nameRefs);
  for (const pa of perAction) {
    for (const s of pa.sources) {
      s.subjectName = names.get(`${s.subjectType}:${s.subjectId}`) ?? null;
    }
  }

  const actions = perAction.filter((p) => p.allowed).map((p) => p.action);
  return {
    node: {
      id: first.node.id, kind: first.node.kind,
      resourceType: first.node.resourceType, name: first.node.name,
    },
    userId: targetUserId,
    actions,
    policyVersion: version,
    perAction,
  };
}
