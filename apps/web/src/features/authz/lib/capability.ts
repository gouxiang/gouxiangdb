// M4 权限能力位门控（fail-closed 纯函数，单一真源）。
//
// 纪律（M4-FE handoff §1）：继承切换 + 策略编辑/保存入口，仅当 /meta 显式下发
// authzManage === true 才放行。字段缺失 / undefined / false / meta 探针失败（null）
// 一律判 false。
//
// 后端下发口径：authzManage = 当前用户持有超级管理员/管理员系统角色 ∨ 任一 manage_* 组织动作
// （见 apps/api/src/routes/v1/index.ts 的 authzManageFlag）。
// **与 GX_AUTHZ_ENGINE 总门解耦**：引擎默认 off / 降级 shadow，实际鉴权决策走旧三表，
// 挂总门会让管理员在任何环境都只能看到只读视图（「权限编辑未在本环境开放」的根因）。
// 只读解释类（effective 来源链 / visible-scope / breadcrumb 截断标记）不经过此门控。
import type { EnterpriseMeta } from "../../../api/client";

/**
 * 是否放行权限【写】能力（策略编辑/保存、继承 Break/Restore 开关）。
 * 严格全等 true：任何其它取值（undefined/false/0/"true"）都不放行。
 */
export function canManageAuthz(meta: EnterpriseMeta | null | undefined): boolean {
  return meta?.authzManage === true;
}

/** 门控三态：探针未完成（loading）时也必须按关闭处理，直到拿到明确 true。 */
export type AuthzGateState = "loading" | "off" | "on";

export function authzGateState(
  meta: EnterpriseMeta | null | undefined,
  isLoading: boolean,
): AuthzGateState {
  if (canManageAuthz(meta)) return "on";
  return isLoading ? "loading" : "off";
}
