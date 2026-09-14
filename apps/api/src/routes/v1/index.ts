// M2/S2 /api/v1 装配骨架。
//
// 与旧 /api 平级独立 Hono 实例：app.ts 在 GX_ENTERPRISE_ORG!=off 时 mount.route("/api/v1", v1)。
// 本片刻只挂一个需登录的 GET /meta 探针，验证"鉴权链 + 条件挂载"打通；
// S3 起在其下挂 /org/departments、/org/members、/org/roles。
//
// 响应风格沿用现网：成功返回资源本体，错误经全局 errorResponse 输出 {error,code}
// （不引入 {code,data,message} 信封，见计划 §4.4/总监裁决 2）。

import { Hono } from "hono";
import { requireActiveUser } from "../../middleware/authActive.js";

export const v1 = new Hono();

// v1 全部端点要求登录且账号 ACTIVE/tv 匹配（S3 起的子路由共享此链）。
v1.use("*", requireActiveUser);

// 装配探针：返回当前登录主体的组织态，供冒烟/端到端确认 v1 已挂载且鉴权核心生效。
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
