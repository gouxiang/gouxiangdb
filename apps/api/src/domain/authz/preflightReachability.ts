// apps/api/src/domain/authz/preflightReachability.ts
// 通电前体检【语义面】：库级判定可达性抽样。
//
// 为什么必须有这一段：七守全部在【base 节点】判动作（guards.ts:118 ref=base:baseId），
// 而第二代 scope 投影刻意把数据动作（r/u/comment）只挂在 table 节点——库可见逐表展开为
// 窄策略，避免库节点的宽授权经继承淹没逐表/逐字段收窄（scopeProjection.ts 文件头）。
// 于是出现一条纯靠读码看不出的数据事实：库节点查不到 r，但库内表节点查得到。
// on 态下 requireCanView/requireCanEditData/requireCanComment 会把这类用户判成 403
// （DRIFT_OVERDENY），且因为旧三表成员有 legacy user 行顶着，观察期不会暴露。
//
// 本模块不修它（修投影会变成 OVERALLOW 越权），只把它【量化成体检项】：
//   对每个（角色 × 库）抽样，用真引擎 decide 分别判库节点与库内活表节点，
//   库=false 且任一表=true 即计一次「库级不可达」——通电即 OVERDENY 的候选。
//
// 只读、有界（角色/库/表/动作均设上限），不写库、不接线。

import type { ResourceAction } from "@gx/shared-types";
import type { AuthzClient, ResolvedSubject } from "./types.js";
import { decide, type EngineDeps } from "./engine.js";
import { NavChainCache, navVersionOf } from "./nodes.js";
import { nodeId } from "../nav/backfill.js";

/** 硬短路角色不参与（授权走 owner fallback，不经策略行）。 */
const SUPER_ADMIN_ROLE_ID = "role_owner";

export interface ReachabilitySample {
  roleId: string;
  libraryId: string;
  action: ResourceAction;
  /** 库节点判定结果。 */
  library: boolean;
  /** 库内活表节点判定并集（OR）。 */
  anyTable: boolean;
}

export interface PreflightReachability {
  /** 实际抽样数（角色×库×动作）。 */
  sampled: number;
  /** 库=false 且任一表=true 的次数：on 态必现 OVERDENY。 */
  libraryUnreachable: number;
  /** 样例（最多 10 条，够定位）。 */
  samples: ReachabilitySample[];
  /** 引擎判定抛错（nav 节点缺失等）的抽样数；非零说明 nav 面有问题，另查 M3。 */
  errors: number;
}

/** 抽样上限（保证体检是有界动作，不为大库拖垮）。 */
const LIMITS = { roles: 3, libraries: 8, tables: 3 } as const;
const ACTIONS: readonly ResourceAction[] = ["r", "u"];

function subjectOf(roleId: string): ResolvedSubject {
  return {
    userId: "",
    roleIds: [roleId],
    departments: [],
    deptAncestorIds: [],
    isWorkspaceOwner: false,
  };
}

/**
 * 只读抽样：库节点 vs 库内活表节点，逐动作对拍。
 * 判定一律走真引擎 decide（不另写判定规则），共享 NavChainCache 控制往返。
 */
export async function computeLibraryReachability(client: AuthzClient): Promise<PreflightReachability> {
  const out: PreflightReachability = { sampled: 0, libraryUnreachable: 0, samples: [], errors: 0 };

  const roleIds = [
    ...new Set(
      (await client.roleLibraryScope.findMany({ select: { roleId: true } })).map((r) => r.roleId),
    ),
  ].filter((id) => id !== SUPER_ADMIN_ROLE_ID).sort().slice(0, LIMITS.roles);
  if (roleIds.length === 0) return out;

  const bases = await client.base.findMany({
    where: { deletedAt: null }, select: { id: true }, take: LIMITS.libraries,
  });
  if (bases.length === 0) return out;

  const version = await navVersionOf(client, "ws_default");
  const cache = new NavChainCache();

  for (const roleId of roleIds) {
    for (const { id: libraryId } of bases) {
      const tableIds = (await client.table.findMany({
        where: { baseId: libraryId, deletedAt: null }, select: { id: true }, take: LIMITS.tables,
      })).map((t) => t.id);
      if (tableIds.length === 0) continue;

      const deps: EngineDeps = { client, cache, navVersion: version };
      const subject = subjectOf(roleId);
      for (const action of ACTIONS) {
        let library = false;
        let anyTable = false;
        let failed = false;
        try {
          library = (await decide(deps, subject, nodeId("base", libraryId), action)).decision.allowed;
          for (const tid of tableIds) {
            const d = await decide(deps, subject, nodeId("table", tid), action);
            if (d.decision.allowed) { anyTable = true; break; }
          }
        } catch {
          failed = true;
        }
        if (failed) { out.errors += 1; continue; }
        out.sampled += 1;
        if (!library && anyTable) {
          out.libraryUnreachable += 1;
          if (out.samples.length < 10) {
            out.samples.push({ roleId, libraryId, action, library, anyTable });
          }
        }
      }
    }
  }
  return out;
}
