// /api/v1 装配骨架（M2/S2 建，M3/S5 改双 flag 条件挂载）。
//
// app.ts 在 config.enterpriseOrg || config.enterpriseNav 时 mount.route("/api/v1", v1)；
// 子路由在本实例内按各自 flag 条件挂载，未启用时落入 v1 自身 404：
//   - enterpriseOrg：/org/*、/meta、公开邀请（app.ts 侧）；
//   - enterpriseNav：/workspaces/current/tree|menu、/nav/groups、/nodes/:id/move。
// 两个 flag 正交：仅一个 on 时只暴露对应子面。
//
// 响应风格沿用现网：成功返回资源本体，错误经全局 errorResponse 输出 {error,code}
// （不引入 {code,data,message} 信封，见计划 §4.4/总监裁决 2/5）。

import { Hono } from "hono";
import { requireActiveUser } from "../../middleware/authActive.js";
import { config } from "../../config.js";
import { org } from "./org/index.js";
import { workspaceRoutes } from "./workspace.js";
import { navRoutes, nodeRoutes } from "./nodes.js";
import { authzRoutes } from "./scope.js";

export const v1 = new Hono();

// v1 全部端点要求登录且账号 ACTIVE/tv 匹配（条件挂载的子路由共享此链）。
v1.use("*", requireActiveUser);

// M4/S4：权限引擎只读探针（本人可查；查他人需工作区 owner）。随企业面 v1 挂载，
// 不受 GX_AUTHZ_ENGINE off/shadow 影响——它直接计算 auth_policies/nav_nodes，不经七守卫。
v1.route("/authz", authzRoutes);

if (config.enterpriseOrg) {
  // 组织通讯录管理面（部门/成员/角色）+ 装配探针。
  v1.route("/org", org);
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
}
