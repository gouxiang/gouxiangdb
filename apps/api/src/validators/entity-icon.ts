// apps/api/src/validators/entity-icon.ts
// 五类实体「自定义图标 + 图标颜色」的请求体校验片段（zod），四个 PATCH/POST 端点共用。
//
// 实体：Base / KnowledgeBase / Table / KbDoc(kind=doc) / KbDoc(kind=canvas)。
// 白名单真源在 @gx/shared-types 的 ENTITY_ICONS（与导航编排 NAV_ICONS 独立，勿混用）。
//
// 语义：
//   icon       —— 必须是 ENTITY_ICONS 之一；null = 清除回默认；缺省 = 不改动。
//   iconColor  —— 必须是 #RRGGBB 六位十六进制；null = 清除回默认；缺省 = 不改动。
//   非法值 → safeParse 失败 → 由各端点沿用自身既有形态返回 400（如 { error: "参数不合法" }）。
//
// 注意：未自定义落 NULL（DB 无默认色），默认图标/默认色一律由前端按实体类型渲染。

import { z } from "zod";
import { ENTITY_ICON_COLOR_RE, isEntityIcon } from "@gx/shared-types";

/** icon：白名单内图标名 | null（清除） | 缺省（不改动）。 */
export const entityIconSchema = z
  .string()
  .refine(isEntityIcon, { message: "icon 不在实体图标白名单（ENTITY_ICONS）内" })
  .nullable()
  .optional();

/** iconColor：#RRGGBB | null（清除） | 缺省（不改动）。 */
export const entityIconColorSchema = z
  .string()
  .regex(ENTITY_ICON_COLOR_RE, { message: "iconColor 必须是 #RRGGBB 六位十六进制颜色" })
  .nullable()
  .optional();
