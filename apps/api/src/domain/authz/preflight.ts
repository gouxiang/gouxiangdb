// apps/api/src/domain/authz/preflight.ts
// 【通电前体检】数据面：一次回答「这个库现在能不能安全通电」。
//
// 只做三件事：
//   1) 覆盖：role_library_scope 存量 vs auth_policies 中 reason='scope:role' 的投影
//      （期望/现存逐角色取自 scopeBackfill.planScopeBackfill，与对账同源，不另算）；
//   2) 对账：reconcile A/B/C/S 四段（S 段是通电头号风险项）；
//   3) legacy 残留：只报告不删（退役是后续切片）。
//
// 判定分两级，避免「有噪声就等于不能通电」的假红：
//   - blocking：投影缺失/逐值不等/结构非法/legacy 悬挂/总门未翻/双写主路径未接线 —— 命中即 NOT_READY；
//   - advisory：A3（按 runbook 只报不改，且 scope 投影动作串本就可能等于旧档，属已知噪声）、
//     legacy 残留（user 主体，引擎按 user/role 并集取；是否越权由 B 段判定）。
//
// 边界：纯域，只依赖注入 client；不 import 全局 db / Hono / guards；不自行开事务。
// 门与代码接线属静态事实，由 CLI 注入（见 scripts/authz/preflight.ts），本文件不做 IO。

import type { AuthzClient } from "./types.js";
import { computeAuthzReconcile } from "./reconcile.js";
import { planScopeBackfill, type ScopeBackfillPlan } from "./scopeBackfill.js";
import {
  computeLibraryReachability,
  type PreflightReachability,
} from "./preflightReachability.js";
import {
  computeScopeVisibility,
  type PreflightScopeVisibility,
} from "./preflightScopeVisibility.js";

/**
 * 阻断码：出现即 NOT_READY。
 * A3 刻意不在其中——reconcile 对 A3 的定性是「疑似手工污染，只报不改」，
 * 而 scope 投影（reason='scope:role'）是机器生成行、其动作串本就可能等于旧角色档，
 * 把它算作阻断会让「通电前全 0」在存量投影完成后仍然不可达（本机 dev.db 实测 12 项）。
 */
const BLOCKING_CODES: ReadonlySet<string> = new Set([
  "A1_MISSING_POLICY",
  "A2_ACTION_MISMATCH",
  "B1_ORPHAN_PROJECTION",
  "B2_BROKEN_NODE",
  "B3_MISSING_USER",
  "C1_BAD_ACTION",
  "C2_DANGLING_FIELD",
  "C3_DANGLING_DEPT",
  "C3_DANGLING_ROLE",
  "C4_DUPLICATE_POLICY",
  "C5_CONDITIONS_INVALID",
  "S1_MISSING",
  "S2_ACTION_MISMATCH",
  "S3_MASK_MISMATCH",
  "S4_ORPHAN",
]);

const LEGACY_PREFIX = "legacy:";

export interface PreflightCoverage {
  /** role_library_scope 总行数。 */
  scopeRows: number;
  /** 有 scope 行的角色数（含硬短路的 role_owner）。 */
  scopeRoles: number;
  /** 参与投影对账的活角色数（不含 role_owner）。 */
  auditedRoles: number;
  /** 现存 reason='scope:role' 策略行数。 */
  stored: number;
  /** 期望投影行数（逐角色 expected 之和，来自 planScopeBackfill）。 */
  expected: number;
  /** expected - stored；非 0 即覆盖缺口/多余。 */
  gap: number;
  /** 期望有投影、现存 0 条的角色（role_owner 永不投影，不在其列）。 */
  rolesWithoutProjection: string[];
  /** 现存 scope:role 投影的主体角色已删除/不存在（惰行，不参与求值）。 */
  danglingProjectionRoles: string[];
}

export interface PreflightReconcileView {
  summary: { A: number; B: number; C: number; S: number };
  /** 按码聚合，供运维一眼看出是哪一类；kind 决定阻断还是提示。 */
  byCode: Array<{ code: string; count: number; kind: "blocking" | "advisory" }>;
}

export interface PreflightLegacyView {
  /** reason='legacy:*' 行数。 */
  total: number;
  byReason: Record<string, number>;
  /** 非 legacy 行的 reason 分布（policy:v1 / null / 其他）——说明现状，不动。 */
  others: Record<string, number>;
}

export interface PreflightData {
  coverage: PreflightCoverage;
  reconcile: PreflightReconcileView;
  legacy: PreflightLegacyView;
  /** 库级判定可达性抽样（语义面一：七守按库节点判，投影按表节点给）。 */
  reachability: PreflightReachability;
  /** 库节点是否进 S4 可见集（语义面二：库整层消失比 403 更硬）。 */
  scopeVisibility: PreflightScopeVisibility;
  /** 底层计划（供 CLI 打印逐角色明细）。 */
  plan: ScopeBackfillPlan;
}

/** 静态事实（由 CLI 注入）：总门与双写代码接线，本文件不读盘、不读 env。 */
export interface PreflightFacts {
  /** src/configAuthz.ts 的 AUTHZ_ENFORCE_READY（false = 总门未翻，on 会降级 shadow）。 */
  enforceReady: boolean;
  hooks: Array<{
    hook: string;
    /** 主路径钩子缺失即阻断；结构性钩子缺失只提示。 */
    required: boolean;
    why: string;
    callSites: string[];
  }>;
}

export interface PreflightReport {
  verdict: "READY" | "NOT_READY";
  blocking: string[];
  advisory: string[];
  data: PreflightData;
  facts: PreflightFacts;
}

async function countReasonGroups(
  client: AuthzClient,
): Promise<{ legacy: Record<string, number>; others: Record<string, number> }> {
  const rows = await client.authPolicy.findMany({ select: { reason: true } });
  const legacy: Record<string, number> = {};
  const others: Record<string, number> = {};
  for (const r of rows) {
    const key = r.reason ?? "(null)";
    const bucket = r.reason?.startsWith(LEGACY_PREFIX) ? legacy : others;
    bucket[key] = (bucket[key] ?? 0) + 1;
  }
  return { legacy, others };
}

/** 只读体检：覆盖 + 对账 + legacy 残留。在事务内调用保证一致快照。 */
export async function computePreflightData(client: AuthzClient): Promise<PreflightData> {
  const plan = await planScopeBackfill(client);

  const scopeRoleIds = new Set(
    (await client.roleLibraryScope.findMany({ select: { roleId: true } })).map((r) => r.roleId),
  );
  const liveRoleIds = new Set(
    (await client.role.findMany({ where: { deletedAt: null }, select: { id: true } })).map((r) => r.id),
  );
  const storedRoleIds = new Set(
    (await client.authPolicy.findMany({
      where: { subjectType: "role", reason: "scope:role" },
      select: { subjectId: true },
    })).map((r) => r.subjectId),
  );

  const coverage: PreflightCoverage = {
    scopeRows: plan.totals.scopeRows,
    scopeRoles: scopeRoleIds.size,
    auditedRoles: [...liveRoleIds].filter((id) => id !== "role_owner").length,
    stored: plan.totals.stored,
    expected: plan.totals.expected,
    gap: plan.totals.expected - plan.totals.stored,
    rolesWithoutProjection: plan.roles
      .filter((r) => r.roleId !== "role_owner" && r.expected > 0 && r.stored === 0)
      .map((r) => r.roleId),
    danglingProjectionRoles: [...storedRoleIds].filter((id) => !liveRoleIds.has(id)).sort(),
  };

  const report = await computeAuthzReconcile(client);
  const tally = new Map<string, number>();
  for (const group of [report.A, report.B, report.C, report.S]) {
    for (const d of group) tally.set(d.code, (tally.get(d.code) ?? 0) + 1);
  }
  const reconcile: PreflightReconcileView = {
    summary: { ...report.summary },
    byCode: [...tally.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([code, count]) => ({
        code,
        count,
        kind: BLOCKING_CODES.has(code) ? "blocking" as const : "advisory" as const,
      })),
  };

  const { legacy, others } = await countReasonGroups(client);
  const legacyView: PreflightLegacyView = {
    total: Object.values(legacy).reduce((a, b) => a + b, 0),
    byReason: legacy,
    others,
  };

  return {
    coverage,
    reconcile,
    legacy: legacyView,
    reachability: await computeLibraryReachability(client),
    scopeVisibility: await computeScopeVisibility(client),
    plan,
  };
}

/** 纯函数：数据 + 静态事实 -> 总体判定。（可单测，无需真库） */
export function evaluatePreflight(data: PreflightData, facts: PreflightFacts): PreflightReport {
  const blocking: string[] = [];
  const advisory: string[] = [];

  if (data.coverage.gap !== 0) {
    blocking.push(
      `存量覆盖缺口：期望 scope 投影 ${data.coverage.expected} 行，现存 ${data.coverage.stored} 行`
        + `（差 ${data.coverage.gap}；先跑 scripts/authz/project-scope.ts --apply）`,
    );
  }
  if (data.coverage.rolesWithoutProjection.length > 0) {
    blocking.push(`以下角色一条 scope 投影都没有：${data.coverage.rolesWithoutProjection.join(", ")}`);
  }
  if (data.coverage.danglingProjectionRoles.length > 0) {
    advisory.push(
      `scope:role 投影指向已删角色（惰性，不参与求值）：${data.coverage.danglingProjectionRoles.join(", ")}`,
    );
  }

  if (data.reachability.libraryUnreachable > 0) {
    const first = data.reachability.samples[0];
    blocking.push(
      `库级判定不可达 ${data.reachability.libraryUnreachable}/${data.reachability.sampled} 个抽样：`
        + `七守在【库节点】判 r/u，而投影把数据动作挂在【表节点】，on 态 requireCanView/`
        + `requireCanEditData/requireCanComment 会 403（例：${first?.roleId}@${first?.libraryId} ${first?.action}）`
        + `——两条直觉修法均已证伪：投影层给库节点补 r 会淹没逐表收窄（OVERALLOW，fieldMask.ts:97 `
        + `无 mask 即 visibleAll），enforceGate 改走库内活表并集则与可见集分叉（scope.ts:174 按节点 r 判）`,
    );
  }
  if (data.reachability.errors > 0) {
    advisory.push(`库级抽样中有 ${data.reachability.errors} 次引擎判定抛错（多为 nav 节点缺失，先跑 reconcile-nav）`);
  }

  if (data.scopeVisibility.orphanTableUsers > 0) {
    blocking.push(
      `库节点缺席可见集：${data.scopeVisibility.orphanTableUsers}/${data.scopeVisibility.sampledUsers} 个抽样用户`
        + `【表/视图可见、但库节点一个都不可见】（库节点抽样 ${data.scopeVisibility.visible}`
        + `/${data.scopeVisibility.checked} 可见）——通电后 M5「先收敛后召回」与 M3 导航剪枝会把库整层`
        + `抹掉：能看表、点不进库、检索只召回表。比七守 403 更硬，同一根因（引擎缺「库级可见性」`
        + `一等表达），待架构裁决后由投影层重跑 project-scope --apply 收敛`,
    );
  }

  for (const item of data.reconcile.byCode) {
    if (item.kind === "blocking") {
      blocking.push(`对账 ${item.code} 共 ${item.count} 项（通电阻断）`);
    } else {
      advisory.push(`对账 ${item.code} 共 ${item.count} 项（按 runbook 只报不改，不阻断）`);
    }
  }

  if (data.legacy.total > 0) {
    const detail = Object.entries(data.legacy.byReason)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    advisory.push(
      `legacy 残留 ${data.legacy.total} 行（${detail}）：user 主体策略，引擎按 user/role 并集取；`
        + `本脚本不删，是否越权由 B 段判定`,
    );
  }
  const otherCount = Object.values(data.legacy.others).reduce((a, b) => a + b, 0);
  if (otherCount > 0) {
    const detail = Object.entries(data.legacy.others).map(([k, v]) => `${k}=${v}`).join(" ");
    advisory.push(`非 legacy 策略行 ${otherCount} 行（${detail}）：非本次投影产物，保持原样`);
  }

  if (!facts.enforceReady) {
    blocking.push("AUTHZ_ENFORCE_READY=false（总门未翻）：env=on 会被运行时降级 shadow，此刻翻门是空转");
  }
  for (const h of facts.hooks) {
    if (h.callSites.length === 0) {
      const msg = `双写钩子 ${h.hook}（${h.why}）无生产调用点`;
      if (h.required) blocking.push(msg);
      else advisory.push(msg);
    }
  }

  return {
    verdict: blocking.length === 0 ? "READY" : "NOT_READY",
    blocking,
    advisory,
    data,
    facts,
  };
}
