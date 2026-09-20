// M6 建库/建知识库权限门（第六枚组织动作 create_library）。
//
// 产品规则：新建 Base / 知识库不是所有登录用户的默认能力，必须由管理员在后台【按角色】
// 分配（授予给角色，角色再授予用户或部门，不是直接分配给具体的人）。判定复用既有组织
// 动作体系：用户任一有效组织角色的 actions 含 create_library 即放行。
//
// 兜底（正式产品规则，不是测试后门）：实例里若【不存在任何角色授予】，说明该部署尚未
// 启用组织角色体系——例如 GX_ENTERPRISE_ORG=off 的私有部署，或管理员还没完成初始化
// 的新实例。此时组织角色体系根本没在运行，不能把所有人锁死在建库门外，故保持既有的
// "登录即可建库"旧行为。一旦出现第一条授予，即视为体系已启用，权限门开始生效。

import { prisma } from "../../db.js";
import { HttpError } from "../../guards.js";
import { hasOrgAction } from "./authorization.js";

/** 建库/建知识库无权限文案（两处端点共用，便于测试与文案统一）。 */
export const CREATE_LIBRARY_DENIED = "没有新建库/知识库的权限，请联系管理员开通";

/**
 * 断言 userId 可以新建库/知识库；无权限抛 403 HttpError（路由层经 errorResponse 映射）。
 * 见文件头：无任何角色授予的实例直接放行。
 */
export async function assertCanCreateLibrary(userId: string): Promise<void> {
  const grantCount = await prisma.roleAssignment.count();
  if (grantCount === 0) return;
  if (await hasOrgAction(userId, "create_library")) return;
  throw new HttpError(403, CREATE_LIBRARY_DENIED);
}
