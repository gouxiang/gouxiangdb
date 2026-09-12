// apps/api/src/routes/health.ts
// 健康检查（用于桌面壳/容器编排探测）

import { Hono } from "hono";
import { prisma } from "../db.js";
import { VERSION } from "../version.js";

export const health = new Hono();

health.get("/", async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return c.json({
      ok: true,
      service: "gouxiangdb-api",
      version: VERSION,
      timestamp: new Date().toISOString(),
      db: "ok",
    });
  } catch (e) {
    return c.json(
      {
        ok: false,
        service: "gouxiangdb-api",
        version: VERSION,
        db: "error",
        error: String(e),
      },
      503,
    );
  }
});