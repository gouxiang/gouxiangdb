// apps/api/src/domain/authz/preflightReachability.ts
// 通电前体检【语义面】：库级聚合位与 legacy 的等价性抽样。
//
// 为什么换掉前一版：前一版问的是「库节点判不判得到 r/u」，而 ADR-0056 选定方案 ③ 之后
// **库节点永远不会再被授予 r**（r 只挂在表节点，避免宽来源经继承淹没逐表/逐字段收窄）。
// 于是原指标会永久为 0——但它同时不再能证明任何事，属假绿，故必须替换（定稿 §10.1）。
//
// 本模块问的正确问题：投影出来的两枚聚合位，是否与第二代 legacy 口径逐值等价？
//   enter     == legacy access.visible       （guards.permit 的 canView）
//   edit_data == legacy perm.canEditData     （= canManage ‖ 任一活表可写）
// 任一不等价即计入 mismatch —— 那是 on 态会 OVERDENY / OVERALLOW 的候选，通电阻断。
//
// legacy 期望不重新实现：逐值公式取自 guards.permit（canView=visible、canEditData=canManage‖anyWritable），
// 角色合成取自 scopeSynthesize.synthesizeAccess，管理员覆盖与 scopeProjection 的 adminDtoFor 同口径。
//
// 只读、有界（角色/库设上限，不逐表遍历），不写库、不接线。

import type { ResourceAction } from "@gx/shared-types";
import type { AuthzClient, ResolvedSubject } from "./types.js";
import { decide, type EngineDeps } from "./engine.js";
import { NavChainCache, navVersionOf } from "./nodes.js";
import { nodeId } from "../nav/backfill.js";
import { synthesizeAccess } from "./scopeSynthesize.js";

/** 硬短路角色不参与（授权走 owner fallback，不经策略行）。 */
const SUPER_ADMIN_ROLE_ID = "role_owner";
/** 管理员（F8 硬规则）：合成后强制 visible/canShare/canToggleShare，不强制 canManage。 */
const ADMIN_ROLE_ID = "role_admin";

/** 两枚受检的库级聚合位（ADR-0056 §4）。 */
const AGGREGATE_ACTIONS: readonly ResourceAction[] = ["enter", "edit_data"];

export interface AggregateParitySample {
  roleId: string;
  libraryId: string;
  action: ResourceAction;
  /** 真引擎在库节点上的判定。 */
  engine: boolean;
  /** 第二代 legacy 口径的期望值。 */
  legacy: boolean;
}

/**
 * 等价性抽样结果。类型名沿用 PreflightReachability（体检 [3] 段），
 * 字段改为 mismatches/samples(AggregateParitySample)：旧的 libraryUnreachable 已废弃
 * ——库节点不再有 r，那个指标会恒为 0 却证明不了任何事（假绿，定稿 §10.1）。
 */
export interface PreflightReachability {
  /** 实际抽样数（角色 × 库 × 聚合位）。 */
  sampled: number;
  /** 引擎与 legacy 不等价的【值】数（每对 0/1/2）：非 0 即库级聚合位缺失/不等价，阻断。 */
  mismatches: number;
  /** 不等样例（最多 10 条，够定位）。 */
  samples: AggregateParitySample[];
  /** 引擎判定抛错（nav 节点缺失等）的抽样数；非零说明 nav 面有问题，另查 M3。 */
  errors: number;
}

/** 抽样上限（保证体检是有界动作，不为大库拖垮）。 */
const LIMITS = { roles: 3, libraries: 8 } as const;

function subjectOf(roleId: string): ResolvedSubject {
  return {
    userId: "",
    roleIds: [roleId],
    departments: [],
    deptAncestorIds: [],
    isWorkspaceOwner: false,
  };
}

/** legacy 口径：access.visible 与 perm.canEditData（guards.permit:63-75）。 */
function legacyBits(roleId: string, rows: Array<{ canManage: number; visible: number; canShare: number; config: string }>): {
  visible: boolean;
  canEditData: boolean;
} {
  const dto = synthesizeAccess(
    rows.map((r) => ({
      canManage: r.canManage, visible: r.visible, canShare: r.canShare, config: r.config,
    })),
  );
  // 管理员覆盖（F8）：与 scopeProjection.adminDtoFor 逐字同口径——只强制 visible/canShare/canToggleShare。
  const access = roleId === ADMIN_ROLE_ID
    ? { ...dto, visible: true, canShare: true }
    : dto;
  const anyWritable = Object.values(access.tables).some((t) => t.create || t.update || t.delete);
  return { visible: access.visible, canEditData: access.canManage || anyWritable };
}

/**
 * 只读抽样：库节点的 enter / edit_data 与 legacy visible / canEditData 逐值对拍。
 * 判定一律走真引擎 decide（不另写判定规则），共享 NavChainCache 控制往返。
 */
export async function computeLibraryAggregateParity(
  client: AuthzClient,
): Promise<PreflightReachability> {
  const out: PreflightReachability = { sampled: 0, mismatches: 0, samples: [], errors: 0 };

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
    const rows = await client.roleLibraryScope.findMany({
      where: { roleId, libraryKind: "base" },
      select: { libraryId: true, canManage: true, visible: true, canShare: true, config: true },
    });
    // 按库分组：同库若存量重复多行，一起送合成（synthesize 本就是多源并集），不漏算。
    const byLibrary = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byLibrary.get(r.libraryId) ?? [];
      list.push(r);
      byLibrary.set(r.libraryId, list);
    }

    for (const { id: libraryId } of bases) {
      const legacy = legacyBits(roleId, byLibrary.get(libraryId) ?? []);
      const expected: Record<string, boolean> = { enter: legacy.visible, edit_data: legacy.canEditData };

      const deps: EngineDeps = { client, cache, navVersion: version };
      const subject = subjectOf(roleId);
      for (const action of AGGREGATE_ACTIONS) {
        let engine: boolean;
        try {
          engine = (await decide(deps, subject, nodeId("base", libraryId), action)).decision.allowed;
        } catch {
          out.errors += 1;
          continue;
        }
        out.sampled += 1;
        if (engine !== expected[action]) {
          out.mismatches += 1;
          if (out.samples.length < 10) {
            out.samples.push({ roleId, libraryId, action, engine, legacy: expected[action]! });
          }
        }
      }
    }
  }
  return out;
}
