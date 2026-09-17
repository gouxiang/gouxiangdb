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
import { patRoutes } from "./pats.js";

export const v1 = new Hono();

// v1 全部端点要求登录且账号 ACTIVE/tv 匹配（条件挂载的子路由共享此链）。
v1.use("*", requireActiveUser);

// M4/S4：权限引擎只读探针（本人可查；查他人需工作区 owner）。随企业面 v1 挂载，
// 不受 GX_AUTHZ_ENGINE off/shadow 影响——它直接计算 auth_policies/nav_nodes，不经七守卫。
v1.route("/authz", authzRoutes);

if (config.enterpriseOrg) {
  // 组织通讯录管理面（部门/成员/角色）+ 装配探针。
  v1.route("/org", org);
  // M6/S1 个人访问令牌（PAT）REST：本人限定（C-5 定稿：与 /mcp 同受 GX_ENTERPRISE_ORG 门控，
  // off 即不挂载 -> v1 自身 404）。
  v1.route("/pats", patRoutes);
  v1.get("/meta", (c) => {
    const auth = c.get("auth");
    return c.json({
      apiVersion: "v1",
      enterpriseOrg: true,
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

if (config.m5Search !== "off") {
  // M5/S6 统一检索：仅 on/shadow 挂载；off 时 /api/v1/search 落 v1 自身 404。
  // S6 骨架内一律 501（S7 接 domain/search/query.ts 与 shadow 对拍），不建库不出网。
  v1.route("/search", searchRoutes);
  // M5/S9 检索管理面（reindex/status/embedding config+apiKey，全部 role_owner），与 /search 同门：
  // 仅 on/shadow 可达；off 时 /api/v1/admin/* 落 v1 自身 404，且不产生 search.db（gate 断言）。
  v1.route("/admin", adminSearchRoutes);
}
