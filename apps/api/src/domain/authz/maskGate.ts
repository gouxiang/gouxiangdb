// 路由侧字段掩码编排（权限引擎永久单一化）。
//
// records 列表/详情/写键/CSV 出口在处理早期调 resolveTableMask()：
//   - 恒定构造 FieldMaskSession（引擎永久生效），出口据此用可见字段子集/脱敏 config/注入 hydrate
//     依赖/compile 兜底集/写键守卫；
//   - 引擎内部故障会沿 FieldMaskSession/decide 抛出，由调用方错误出口按 fail-closed 处理。
//
// 不 import Hono/guards（与 adapter 同级，只依赖 prisma/引擎）。

import { prisma } from "../../db.js";
import type { FilterNode, ViewConfig } from "@gx/shared-types";
import type { FieldMeta } from "../types.js";
import type { HydrateDeps } from "../hydrate.js";
import { prismaDeps } from "../prismaDeps.js";
import { FieldMaskSession, type TableMask } from "./maskSession.js";

/** 一次表请求的字段掩码上下文。 */
interface MaskContext {
  session: FieldMaskSession;
  mask: TableMask;
  /** 可见字段定义子集（hydrate 入参 + fields/allFields/CSV 表头同口径）。 */
  visibleFields: FieldMeta[];
  /** 掩码外字段 id 集（compile 编译期物理下推兜底）。 */
  deniedIds: ReadonlySet<string>;
  /** 注入跨表可见性钩子的 hydrate 依赖。 */
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
 * @param userId 已认证的主体
 * @param tableId 表实体 id
 * @param fields loadTableFields 得到的全字段定义
 */
export async function resolveTableMask(
  userId: string,
  tableId: string,
  fields: readonly FieldMeta[],
): Promise<MaskContext> {
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
