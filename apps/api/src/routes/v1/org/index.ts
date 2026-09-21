// M2 /api/v1/org 装配：组织通讯录各资源子路由在此聚合（S3 departments，S4/S5 续挂）。

import { Hono } from "hono";
import { departments } from "./departments.js";
import { memberRoutes } from "./members.js";
import { roles } from "./roles.js";
import { libraryScopeRoutes } from "./roleLibraryScopes.js";

export const org = new Hono();

org.route("/departments", departments);
org.route("/members", memberRoutes);
org.route("/roles", roles);
// B 段库权限的配置面挂在 /org 下（端点自含 /library-scopes 与 /libraries/... 路径）。
org.route("/", libraryScopeRoutes);
