// M4/S2 auth_policies 对账（只读差异计算 + 可选修复），A/B/C 三类（D 类决策漂移 S3 后补）。
//
// 纯域：只依赖注入 client，不 import Hono/guards/config；读旧三表仅为投影对账，不参与运行时决策。
// 期望投影规则与迁移 20260916110000 / backfill.ts 完全一致（活实体 + 活 nav 节点 + 档位白名单）。
// A1/A2 与 B1/B2/B3 在 --apply 时用 backfill.ts 同一原语修复；A3/C 类只报不改（人工/竞态）。

import {
  RESOURCE_ACTIONS,
  normalizeActions,
  parseActionString,
} from "@gx/shared-types";
import {
  isKnownLegacyRole,
  legacyActionString,
  LEGACY_REASONS,
  upsertByLegacyRow,
  type LegacyReason,
  type LegacyRow,
} from "./backfill.js";
import type { AuthzClient } from "./types.js";

export interface ReconcileDiff {
  code: string;
  message: string;
  ref?: string;
}

export interface ReconcileReport {
  A: ReconcileDiff[];
  B: ReconcileDiff[];
  C: ReconcileDiff[];
  counts: { expected: number; policies: number; legacyPolicies: number };
  summary: { A: number; B: number; C: number };
}

export interface ReconcileFixResult {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
}

interface ExpectedRow extends LegacyRow {
  wanted: string;
}

const LEGACY_REASON_SET: ReadonlySet<string> = new Set(Object.values(LEGACY_REASONS));

type LiveNodeMap = Map<string, string>; // `${resourceType}:${resourceId}` -> 活 nav node id

/** 一次取回活 nav 节点映射（NavNode 与实体表刻意无 Prisma 关系，手动反查 [type,rid]）。 */
async function liveNodeMap(client: AuthzClient): Promise<LiveNodeMap> {
  const nodes = await client.navNode.findMany({
    where: { deletedAt: null },
    select: { id: true, resourceType: true, resourceId: true },
  });
  const map: LiveNodeMap = new Map();
  for (const n of nodes) {
    if (n.resourceType && n.resourceId) map.set(`${n.resourceType}:${n.resourceId}`, n.id);
  }
  return map;
}

/** 收集旧三表活行对应的期望投影（与迁移 SQL 同口径）。未知档位行单独返回（报 A1-unmappable）。 */
async function collectExpected(client: AuthzClient): Promise<{ rows: ExpectedRow[]; unknown: ReconcileDiff[] }> {
  const rows: ExpectedRow[] = [];
  const unknown: ReconcileDiff[] = [];
  const nodeOf = await liveNodeMap(client);
  const push = (
    family: LegacyRow["family"],
    reason: LegacyReason,
    r: { oldId: string; resourceKey: string | null; userId: string; role: string },
  ) => {
    const nodeId = r.resourceKey ? nodeOf.get(r.resourceKey) ?? null : null;
    if (!nodeId) return; // 活实体无活节点：M3 reconcile 应已修；此处不投影（不报 A，归 M3 域）
    if (!isKnownLegacyRole(family, r.role)) {
      unknown.push({
        code: "A1_UNMAPPABLE_ROLE",
        message: `旧行角色 ${r.role} 不在 ${family} 档位，无法投影`,
        ref: `${reason}:${r.oldId}`,
      });
      return;
    }
    rows.push({
      oldId: r.oldId, nodeId, userId: r.userId, role: r.role,
      reason, family, wanted: legacyActionString(family, r.role),
    });
  };

  // 活实体 id 集（软删资源的旧行不投影，与迁移 JOIN deletedAt IS NULL 一致）。
  const liveBases = new Set((await client.base.findMany({ where: { deletedAt: null }, select: { id: true } })).map((x) => x.id));
  const liveKbs = new Set((await client.knowledgeBase.findMany({ where: { deletedAt: null }, select: { id: true } })).map((x) => x.id));
  const liveDocs = new Set((await client.kbDoc.findMany({ where: { deletedAt: null }, select: { id: true } })).map((x) => x.id));

  const members = await client.member.findMany({ select: { id: true, baseId: true, userId: true, role: true } });
  for (const m of members) {
    if (!liveBases.has(m.baseId)) continue;
    push("base", LEGACY_REASONS.member, { oldId: m.id, resourceKey: `base:${m.baseId}`, userId: m.userId, role: m.role });
  }

  const kbMembers = await client.kbMember.findMany({ select: { id: true, kbId: true, userId: true, role: true } });
  for (const m of kbMembers) {
    if (!liveKbs.has(m.kbId)) continue;
    push("kb", LEGACY_REASONS.kbMember, { oldId: m.id, resourceKey: `kb:${m.kbId}`, userId: m.userId, role: m.role });
  }

  // ACL 覆盖 doc/canvas：nav 节点 resourceType 等于 kb_docs.kind（PUT /acl 不区分 kind）。
  const acls = await client.kbDocAcl.findMany({
    select: { id: true, docId: true, userId: true, role: true, doc: { select: { kind: true } } },
  });
  for (const a of acls) {
    if (!liveDocs.has(a.docId) || !a.doc) continue;
    push("doc", LEGACY_REASONS.acl, { oldId: a.id, resourceKey: `${a.doc.kind}:${a.docId}`, userId: a.userId, role: a.role });
  }

  return { rows, unknown };
}

function expectedKey(r: { nodeId: string; userId: string }): string {
  return `${r.nodeId}${r.userId}`;
}

/** 计算 A/B/C 差异（只读；在事务内调用保证一致快照）。 */
export async function computeAuthzReconcile(client: AuthzClient): Promise<ReconcileReport> {
  const A: ReconcileDiff[] = [];
  const B: ReconcileDiff[] = [];
  const C: ReconcileDiff[] = [];

  const { rows: expected, unknown } = await collectExpected(client);
  A.push(...unknown);
  const byKey = new Map<string, ExpectedRow>();
  for (const r of expected) byKey.set(expectedKey(r), r);

  const policies = await client.authPolicy.findMany();
  const users = new Set((await client.user.findMany({ select: { id: true } })).map((u) => u.id));
  const liveDepts = new Set((await client.department.findMany({ where: { deletedAt: null }, select: { id: true } })).map((d) => d.id));
  const liveRoles = new Set((await client.role.findMany({ where: { deletedAt: null }, select: { id: true } })).map((r) => r.id));
  const liveFields = new Set((await client.field.findMany({ where: { deletedAt: null }, select: { id: true } })).map((f) => f.id));
  const nodeById = new Map((await client.navNode.findMany({ select: { id: true, deletedAt: true, resourceType: true } })).map((n) => [n.id, n]));

  // 已知档位规范串集合（A3 疑似手工污染识别）。
  const knownActionStrings = new Set<string>();
  for (const fam of ["base", "kb", "doc"] as const) {
    for (const role of fam === "base" ? ["owner", "creator", "editor", "commenter", "viewer"]
      : fam === "kb" ? ["owner", "editor", "commenter", "viewer"] : ["editor", "commenter", "viewer"]) {
      knownActionStrings.add(legacyActionString(fam, role));
    }
  }

  const seenKeys = new Set<string>();
  for (const p of policies) {
    const key = `${p.nodeId}|${p.subjectType}|${p.subjectId}`;
    if (seenKeys.has(key)) {
      C.push({ code: "C4_DUPLICATE_POLICY", message: "同节点同主体出现多行（违反唯一意图）", ref: p.id });
    }
    seenKeys.add(key);

    // C1 非法动作词
    const bad = parseActionString(p.actions).filter((a) => !(RESOURCE_ACTIONS as readonly string[]).includes(a));
    const rawTokens = p.actions.split(",").map((s) => s.trim()).filter(Boolean);
    if (bad.length || rawTokens.length !== normalizeActions(rawTokens).length) {
      C.push({ code: "C1_BAD_ACTION", message: `actions 含非法/非规范动作词: ${p.actions}`, ref: p.id });
    }
    // C5 非空 conditions（M4 无写入路径）
    if (p.conditions !== null && p.conditions !== undefined && p.conditions !== "") {
      C.push({ code: "C5_CONDITIONS_PRESENT", message: "conditions 非空（M4 不支持行级条件写入）", ref: p.id });
    }
    // C3 dept/role 悬挂
    if (p.subjectType === "dept" && !liveDepts.has(p.subjectId)) {
      C.push({ code: "C3_DANGLING_DEPT", message: "dept 主体已删除/不存在", ref: p.id });
    }
    if (p.subjectType === "role" && !liveRoles.has(p.subjectId)) {
      C.push({ code: "C3_DANGLING_ROLE", message: "role 主体已删除/不存在", ref: p.id });
    }
    // C2 fieldMask 引用已删字段（仅 table 节点）
    const node = nodeById.get(p.nodeId);
    if (p.fieldMask && node?.resourceType === "table") {
      for (const f of extractFieldMaskIds(p.fieldMask)) {
        if (!liveFields.has(f)) {
          C.push({ code: "C2_DANGLING_FIELD", message: `fieldMask 引用字段已删除: ${f}`, ref: p.id });
        }
      }
    }
    // A3 非 legacy 行但动作串恰等于旧角色档（疑似手工污染，只报不改）
    if (!p.reason?.startsWith("legacy:") && knownActionStrings.has(normalizeActions(rawTokens).join(","))) {
      A.push({ code: "A3_MANUAL_MATCHES_LEGACY", message: "非 legacy 行动作串等于某旧角色档（疑似手工污染，不自动改）", ref: p.id });
    }

    // B 类：仅巡检 legacy 投影行
    if (p.reason && LEGACY_REASON_SET.has(p.reason)) {
      const nodeOk = node && node.deletedAt === null;
      if (!nodeOk) {
        B.push({ code: "B2_BROKEN_NODE", message: "legacy 投影指向软删/不存在节点", ref: p.id });
        continue;
      }
      if (p.subjectType === "user" && !users.has(p.subjectId)) {
        B.push({ code: "B3_MISSING_USER", message: "legacy 投影主体用户不存在", ref: p.id });
        continue;
      }
      const exp = p.subjectType === "user" ? byKey.get(expectedKey({ nodeId: p.nodeId, userId: p.subjectId })) : undefined;
      if (!exp) {
        B.push({ code: "B1_ORPHAN_PROJECTION", message: "legacy 投影对应的旧三表活行已不存在", ref: p.id });
      } else if (normalizeActions(rawTokens).join(",") !== exp.wanted) {
        A.push({ code: "A2_ACTION_MISMATCH", message: `动作串 ${p.actions} 与映射 ${exp.wanted} 不符`, ref: p.id });
      }
    }
  }

  // A1 缺失：期望有、无任何同键 policy
  for (const r of expected) {
    const exists = policies.some((p) => p.nodeId === r.nodeId && p.subjectType === "user" && p.subjectId === r.userId);
    if (!exists) {
      A.push({ code: "A1_MISSING_POLICY", message: `旧 ${r.reason} 行在节点缺 user 策略`, ref: `${r.nodeId}|${r.userId}` });
    }
  }

  return {
    A, B, C,
    counts: { expected: expected.length, policies: policies.length, legacyPolicies: policies.filter((p) => p.reason && LEGACY_REASON_SET.has(p.reason)).length },
    summary: { A: A.length, B: B.length, C: C.length },
  };
}

function extractFieldMaskIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const m = parsed as { allowFields?: unknown; readOnlyFields?: unknown };
    const pick = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return [...pick(m.allowFields), ...pick(m.readOnlyFields)];
  } catch {
    return [];
  }
}

/** 修复 A1/A2（upsert 期望投影）与 B1/B2/B3（删悬挂 legacy 投影）；A3/C 不动。返计数。 */
export async function applyAuthzReconcileFixes(client: AuthzClient): Promise<ReconcileFixResult> {
  const before = await computeAuthzReconcile(client);
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;

  const fixable = new Set(before.A.filter((d) => d.code === "A1_MISSING_POLICY" || d.code === "A2_ACTION_MISMATCH").map((d) => d.ref));
  const { rows } = await collectExpected(client);
  for (const r of rows) {
    if (!fixable.has(`${r.nodeId}|${r.userId}`)) continue;
    const res = await upsertByLegacyRow(client, r);
    if (res.written === "created") created++;
    else if (res.written === "updated") updated++;
    else skipped++;
  }

  const dangling = new Set(before.B.filter((d) => d.code === "B1_ORPHAN_PROJECTION" || d.code === "B2_BROKEN_NODE" || d.code === "B3_MISSING_USER").map((d) => d.ref));
  for (const id of dangling) {
    const r = await client.authPolicy.deleteMany({ where: { id, reason: { in: [...LEGACY_REASON_SET] } } });
    if (r.count > 0) deleted++;
  }

  return { created, updated, deleted, skipped };
}
