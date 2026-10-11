// /api/v1 装配骨架（M2/S2 建，M3/S5 改双 flag 条件挂载，M5/S6 加 search 第三 flag）。
//
// app.ts 在 config.enterpriseOrg || config.enterpriseNav 时 mount.route("/api/v1", v1)；
// 子路由在本实例内按各自 flag 条件挂载，未启用时落入 v1 自身 404：
//   - enterpriseOrg：/org/*、/meta、公开邀请（app.ts 侧）；
//   - enterpriseNav：/workspaces/current/tree|menu、/nav/groups、/nodes/:id/move；
//   - m5Search(on/shadow)：/search（S6 为 501 骨架，S7 接真实 query；off 不挂，落 404）。
// 前两个 flag 正交：仅一个 on 时只暴露对应子面。m5Search 只决定子路由是否注册；
// 企业双 flag 全 off 时 app.ts 不挂载整个 /api/v1，此时 search 亦不可达（与未升级一致）。
//
// 响应风格沿用现网：成功返回资源本体，错误经全局 errorResponse 输出 {error,code}
// （不引入 {code,data,message} 信封，见计划 §4.4/总监裁决 2/5）。

import { Hono } from "hono";
import { requireActiveUser } from "../../middleware/authActive.js";
import { config } from "../../config.js";
import { org } from "./org/index.js";
import { workspaceRoutes } from "./workspace.js";
import { navRoutes, nodeRoutes } from "./nodes.js";
import { policyRoutes } from "./policies.js";
import { inheritanceRoutes } from "./inheritance.js";
import { authzRoutes } from "./scope.js";
import { searchRoutes } from "./search.js";
import { adminSearchRoutes } from "./adminSearch.js";
import { adminUpdateRoutes } from "./adminUpdate.js";
import { patRoutes } from "./pats.js";
import { effectiveRoleRows } from "../../domain/org/authorization.js";

export const v1 = new Hono();

/**
 * 权限管理能力位：当前用户能否进「工作区设置 → 权限管理」并使用写能力。
 *
 * 口径 = 持有超级管理员/管理员系统角色 ∨ 持有任一 manage_* 组织动作。与 routes/v1/workspace.ts
 * 的 isWorkspaceAdmin 同族（同一个 effectiveRoleRows 真源）。
 *
 * 口径对齐（新权限模型）：系统角色 systemKey 已从 'owner' 改为 'super_admin'，旧的
 * `systemKey === "owner"` 判断在运行期恒为 false；虽有 manage_* 分支兜住预设角色，但那只是
 * 巧合——预设角色之所以能进，是因为它们恰好持有全部细粒度动作，不应用这个巧合当判据。
 * 显式列出两个管理角色，manage_* 分支保留给「持旧粗粒度动作的自定义角色」（迁移
 * 20260921010000 会把它们补进细粒度动作但保留旧位，故这些角色仍走 manage_* 命中）。
 *
 * **与引擎执法正交**：`authzManage` 只回答「这个人是不是组织权限管理者」，
 * 用于决定权限管理面板是否可写；它不参与引擎对具体资源的放行裁决。
 *
 * fail-closed：查询抛错一律 false，不让 /meta（能力探针）因此 500。
 */
async function authzManageFlag(userId: string): Promise<boolean> {
  try {
    const roles = await effectiveRoleRows(userId);
    return roles.some(
      (r) =>
        r.systemKey === "super_admin" ||
        r.systemKey === "admin" ||
        r.actions.some((a) => a.startsWith("manage_")),
    );
  } catch {
    return false;
  }
}

// v1 全部端点要求登录且账号 ACTIVE/tv 匹配（条件挂载的子路由共享此链）。
v1.use("*", requireActiveUser);

// M4/S4：权限引擎只读探针（本人可查；查他人需工作区 owner）。随企业面 v1 挂载，
// 直接在 auth_policies/nav_nodes 上批量计算，不经七守卫。
v1.route("/authz", authzRoutes);

if (config.enterpriseOrg) {
  // 组织通讯录管理面（部门/成员/角色）+ 装配探针。
  v1.route("/org", org);
  // M6/S1 个人访问令牌（PAT）REST：本人限定（C-5 定稿：与 /mcp 同受 GX_ENTERPRISE_ORG 门控，
  // off 即不挂载 -> v1 自身 404）。
  v1.route("/pats", patRoutes);
  v1.get("/meta", async (c) => {
    const auth = c.get("auth");
    return c.json({
      apiVersion: "v1",
      enterpriseOrg: true,
      // 权限管理写能力位。见 authzManageFlag 的口径注释：与引擎执法正交。
      authzManage: await authzManageFlag(auth.userId),
      auth: {
        userId: auth.userId,
        status: auth.status,
        workspaceId: auth.workspaceId,
      },
    });
  });
}

if (config.enterpriseNav) {
  // M3 统一导航资源树：tree/menu 读 + menu 编排写 + group/move（均挂 v1 鉴权链）。
  v1.route("/workspaces", workspaceRoutes);
  v1.route("/nav", navRoutes);
  v1.route("/nodes", nodeRoutes);
  // M4/S5 节点策略管理/决策解释（/:id/policies、/:id/effective），与 move 同前缀分路由器挂载。
  v1.route("/nodes", policyRoutes);
  // M4/S7 中断继承影响/PATCH 与面包屑（/:id/inheritance/*、/:id/breadcrumb），同前缀分路由器。
  v1.route("/nodes", inheritanceRoutes);
}

// M5/S6 统一检索：恒挂载（不再按 env 静态摘挂）——否则后台 app_settings 的 search.enabled
// 在 GX_M5_SEARCH=off 时永远救不回来，等于做个点了没反应的开关。是否可用改由请求期判定：
//   /api/v1/search      -> search.ts 开头 loadSearchGateFlag（db 覆盖优先）；
//   /api/v1/admin/*     -> adminSearch.ts 的同款闸门中间件。
// 判定为 off 时仍落 404 NOT_FOUND，且**在任何 search.db 访问之前**短路（零建库断言不变）。
v1.route("/search", searchRoutes);
// M5/S9 检索管理面（reindex/status/embedding config+apiKey，全部 role_owner），与 /search 同门：
//   运营/出网端点（reindex、search/status、test-connection）由总门判定，off 时 404 且不建库不出网；
//   配置面端点（embedding config GET/PATCH、api-key）不受总门约束——search.enabled 要在那里被打开。
v1.route("/admin", adminSearchRoutes);

// 应用版本更新检查（DESIGN §6.1）：总开关默认 on，GX_UPDATE_ENABLED=off 时不注册 -> 落 v1 404。
// 与 adminSearch 同前缀 /admin 不同路径分路由器叠加挂载（Hono 支持，项目已有 /nodes 多例先例）。
if (config.update.enabled) {
  v1.route("/admin", adminUpdateRoutes);
}
