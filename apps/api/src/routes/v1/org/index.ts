// M2 /api/v1/org 装配：组织通讯录各资源子路由在此聚合（S3 departments，S4/S5 续挂）。

import { Hono } from "hono";
import { departments } from "./departments.js";

export const org = new Hono();

org.route("/departments", departments);
