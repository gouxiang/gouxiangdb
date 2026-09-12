// apps/api/src/routes/healthz.ts
// GET /healthz — liveness：进程事件循环存活即 200。不查库、不鉴权、不依赖任何下游。

import { Hono } from "hono";
import { SERVICE_NAME } from "../ops/readiness.js";
import { VERSION } from "../version.js";

export const healthz = new Hono();

healthz.get("/", (c) =>
  c.json({
    status: "ok",
    service: SERVICE_NAME,
    version: VERSION,
    time: new Date().toISOString(),
  }),
);
