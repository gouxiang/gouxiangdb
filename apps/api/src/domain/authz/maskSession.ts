// M4/S6 fieldMask 五出口编排层（计划 §4.4/§7-S6，裁决 A-4）。
//
// 引擎永久单一化后字段掩码恒生效，由路由为单请求主体构造
// 一次本会话，加载 table 节点 cutoff 链命中策略 -> fieldCapability，供五出口使用：
//   1. 列表/详情/CSV：visibleFields() 子集喂 hydrate（隐藏物理列在 merged 缺席，公式引用它时
//      buildFormulaSource 找不到字段天然返回 FNULL——零新求值分支，mask-null 与真空值不可区分）；
//      字段清单 fields/allFields/CSV 表头用同一可见子集；
//   2. groups/aggregations：sanitizeConfig() 在查询前抹掉隐藏字段引用（分组字段隐藏->groups=null，
//      聚合隐藏列删除），recordService/queryPlan 内部不出现任何掩码分支（计划行149/269）；
//   3. 写键：create/patch/bulk-update 事务前 assertWritable()（隐藏/只读键 403，整单不开事务）；
//   4. 物理 compile：deniedFieldIds() 交 compilePlan 做编译期兜底，禁止掩码外字段物理下推；
//   5. 跨表 LinkRef 两档：withHydrateDeps() 向 hydrate 注入 resolveFieldVisibility，
//      对端表不可见->引用整体缺席；表可见但展示字段 mask->title=真实 recordId（在 hydrate 内收口）。
//
// 边界：本层可 import db/config/引擎（与 adapter 同级），不 import Hono/guards；表级节点可达性
//   不由 S6 判定（旧成员守卫已保证进得来出口），本层只做字段维收窄（只减不增）。off/shadow 时
//   路由不构造本层（零引擎 SQL）；creator/workspace owner 经合成宽来源兜底全可见（与 decide 同源）。

import type { FilterNode, ViewConfig } from "@gx/shared-types";
import type { AuthzClient, ScopedPolicy } from "./types.js";
import { combineRowConditions } from "./rowFilter.js";
import type { FieldMeta } from "../types.js";
import type { HydrateDeps } from "../hydrate.js";
import { nodeId } from "../nav/backfill.js";
import { resolveSubject } from "./subjects.js";
import { collectScopedNodes, type EngineDeps } from "./engine.js";
import { makeCreatedByResolver } from "./adapter.js";
import {
  fieldCapability,
  assertFieldsWritable,
  filterVisibleFieldDefs,
  sanitizeViewConfigForMask,
  syntheticWidePolicy,
  NON_WRITABLE_FIELD_TYPES,
  type FieldCapability,
} from "./fieldMask.js";

/** 主体在一张表上的掩码判定。 */
export interface TableMask {
  /** 字段能力（cap.visible=false=表级无任何 r 来源，跨表 LinkRef ②档用）。 */
  cap: FieldCapability;
  /** 可见字段 id 集；null=不裁剪（visibleAll：宽来源/creator/owner）。 */
  visibleIds: ReadonlySet<string> | null;
  /** 合并后的行级过滤器；null=不做行级过滤（无 r 来源或命中宽来源）。 */
  rowFilter: FilterNode | null;
}

/**
 * 一张表对当前主体的可见性（hydrate 跨表用，结构类型，hydrate 不反向 import authz）：
 *   null=不裁剪；tableVisible=false=表级完全不可见；true+visibleIds=仅集合内可见。
 */
export interface TableVisibility {
  tableVisible: boolean;
  visibleIds: ReadonlySet<string> | null;
}

/** 服务端计算/系统/autoNumber/tabs 字段不接受物理直写（单源 NON_WRITABLE_FIELD_TYPES，见 fieldMask.ts）。 */

export class FieldMaskSession {
  private subjectP: ReturnType<typeof resolveSubject> | null = null;
  private readonly deps: EngineDeps;
  private readonly cache = new Map<string, TableMask>();

  private constructor(private readonly client: AuthzClient, private readonly userId: string) {
    this.deps = { client, workspaceId: "ws_default", resolveCreatedBy: makeCreatedByResolver(client) };
  }

  /** 工厂：路由为每个请求主体构造（引擎永久生效）。 */
  static async create(client: AuthzClient, userId: string): Promise<FieldMaskSession> {
    return new FieldMaskSession(client, userId);
  }

  private async subject() {
    if (!this.subjectP) this.subjectP = resolveSubject(this.userId, this.client);
    return this.subjectP;
  }

  /** 加载（带缓存）主体在某 table 节点 cutoff 链上的字段能力（含 creator/owner 兜底）。 */
  async forTable(tableId: string): Promise<TableMask> {
    const hit = this.cache.get(tableId);
    if (hit) return hit;

    const subject = await this.subject();
    const tableNodeId = nodeId("table", tableId);
    const { policies, node } = await collectScopedNodes(this.deps, subject, tableNodeId);

    // creator/workspace owner 兜底与 engine.decide -> evaluateChainDecision 同源同义：
    // 兜底成立等价追加一条不裁剪宽来源，cap 自然全可见/全可写，不另写第二套判定。
    const isCreator = this.deps.resolveCreatedBy
      ? (await this.deps.resolveCreatedBy(node)) === this.userId
      : false;
    const effective: ScopedPolicy[] = isCreator || subject.isWorkspaceOwner
      ? [...policies, syntheticWidePolicy(this.userId, node.id)]
      : policies;

    const cap = fieldCapability(effective);
    let visibleIds: Set<string> | null = null;
    if (cap.visible && !cap.visibleAll) {
      visibleIds = new Set();
      for (const p of cap.readSources) {
        if (p.fieldMask?.allowFields) for (const f of p.fieldMask.allowFields) visibleIds.add(f);
      }
    }
    // 行级条件与 fieldMask 同源：同一 effective（含 creator/owner syntheticWidePolicy）
    // 中动作含 r 的来源；syntheticWidePolicy.rowConditions=null，其命中即宽（rowFilter=null）。
    const rPoliciesForRows = effective.filter((p) => p.actions.includes("r"));
    const rowFilter = combineRowConditions(rPoliciesForRows);
    const mask: TableMask = { cap, visibleIds, rowFilter };
    this.cache.set(tableId, mask);
    return mask;
  }

  /** 可见字段子集（hydrate 入参 + fields/allFields/CSV 表头同口径）。 */
  visibleFields(fields: readonly FieldMeta[], mask: TableMask): FieldMeta[] {
    return filterVisibleFieldDefs(fields, mask.cap);
  }

  /** 视图脱敏（物理 compile 与内存 applyViewQuery 共用同一份，双读路径零分叉）。 */
  sanitizeConfig(config: ViewConfig, mask: TableMask): ViewConfig {
    if (!mask.visibleIds) return config;
    return sanitizeViewConfigForMask(config, mask.visibleIds);
  }

  /** compile 编译期兜底用的掩码外字段集（visibleAll 时空集，compile 行为与 off 一字不变）。 */
  deniedFieldIds(fields: readonly FieldMeta[], mask: TableMask): ReadonlySet<string> {
    if (!mask.visibleIds) return new Set();
    const denied = new Set<string>();
    for (const f of fields) if (!mask.visibleIds.has(f.id)) denied.add(f.id);
    return denied;
  }

  /**
   * 写键守卫（事务前）：只校验本表物理可写字段键（含 links/subtable 写 link_row）。
   * 服务端计算/系统/autoNumber/tabs 键 applyFieldWrites 本就跳过，不纳入；
   * 出现不可见/只读键 -> AuthzFieldError(403 FORBIDDEN_FIELD)，整单不开事务。
   */
  assertWritable(keys: readonly string[], fields: readonly FieldMeta[], mask: TableMask): void {
    const candidates = keys.filter((k) => {
      const f = fields.find((x) => x.id === k);
      return !!f && !NON_WRITABLE_FIELD_TYPES.has(f.type);
    });
    assertFieldsWritable(candidates, mask.cap);
  }

  /** 注入 hydrate 的跨表可见性解析（主表 + 对端表共用，按表缓存，单请求生命期）。 */
  resolveFieldVisibility(tableId: string): Promise<TableVisibility | null> {
    return this.forTable(tableId).then((m) =>
      !m.cap.visible ? { tableVisible: false, visibleIds: null } : { tableVisible: true, visibleIds: m.visibleIds });
  }

  /** 包进 HydrateDeps（on 态用；off/shadow 路由直接用 prismaDeps，无此钩子、零开销）。 */
  withHydrateDeps(deps: HydrateDeps): HydrateDeps {
    return { ...deps, resolveFieldVisibility: (t) => this.resolveFieldVisibility(t) };
  }
}
