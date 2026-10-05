// M4/S6 路由侧 fieldMask 门控编排（计划 §4.4/§7-S6 行622）。
//
// 唯一把"独立字段门 fieldMaskEnforceEffective"接入请求的地方：records 列表/详情/写键/CSV
// 出口在处理早期调 resolveTableMask()：
//   - off/shadow（默认）-> null：路由走原路径，不构造 FieldMaskSession、不实例化引擎、零新增 SQL，
//     响应与 M3/M4-S0 金标准逐字节一致；
//   - on（GX_AUTHZ_ENGINE=on 且字段门就绪，独立于 S10 才翻的节点守卫全局门）-> MaskContext，
//     出口据此用可见字段子集/脱敏 config/注入 hydrate 依赖/compile 兜底集/写键守卫。
//
// 不 import Hono/guards（与 adapter 同级，只依赖 prisma/config/引擎）。

import { prisma } from "../../db.js";
import { fieldMaskEnforceEffective } from "../../configAuthz.js";
import type { FilterNode, ViewConfig } from "@gx/shared-types";
import type { FieldMeta } from "../types.js";
import type { HydrateDeps } from "../hydrate.js";
import { prismaDeps } from "../prismaDeps.js";
import { FieldMaskSession, type TableMask } from "./maskSession.js";

/** on 态一次表请求的字段掩码上下文；off/shadow 时 resolveTableMask 返回 null。 */
interface MaskContext {
  session: FieldMaskSession;
  mask: TableMask;
  /** 可见字段定义子集（hydrate 入参 + fields/allFields/CSV 表头同口径）。 */
  visibleFields: FieldMeta[];
  /** 掩码外字段 id 集（compile 编译期物理下推兜底）。 */
  deniedIds: ReadonlySet<string>;
  /** 注入跨表可见性钩子的 hydrate 依赖（off 态出口直接用 prismaDeps）。 */
  hydrateDeps: HydrateDeps;
  /** 视图配置脱敏（物理 compile 与内存精修共用同一份）。 */
  sanitizeConfig: (config: ViewConfig) => ViewConfig;
  /** 写键守卫（create/patch/bulk-update 事务前）。 */
  assertWritable: (keys: readonly string[]) => void;
  /** 合并后的行级过滤器；null=不做行级过滤。 */
  rowFilter: FilterNode | null;
}

/**
 * 解析当前请求在某表上的字段掩码上下文。
 * @param userId 已由旧成员守卫认证的主体
 * @param tableId 表实体 id
 * @param fields loadTableFields 得到的全字段定义
 */
export async function resolveTableMask(
  userId: string,
  tableId: string,
  fields: readonly FieldMeta[],
): Promise<MaskContext | null> {
  if (!fieldMaskEnforceEffective()) return null;
  const session = await FieldMaskSession.create(prisma, userId);
  const mask = await session.forTable(tableId);
  const visibleFields = session.visibleFields(fields, mask);
  return {
    session,
    mask,
    visibleFields,
    deniedIds: session.deniedFieldIds(fields, mask),
    hydrateDeps: session.withHydrateDeps(prismaDeps),
    sanitizeConfig: (config) => session.sanitizeConfig(config, mask),
    assertWritable: (keys) => session.assertWritable(keys, fields, mask),
    rowFilter: mask.rowFilter,
  };
}
