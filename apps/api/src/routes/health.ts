// apps/api/src/routes/health.ts
// 健康检查（用于桌面壳/容器编排探测）

import { Hono } from "hono";
import { prisma } from "../db.js";

export const health = new Hono();

health.get("/", async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return c.json({
      ok: true,
      service: "gouxiangdb-api",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
      db: "ok",
    });
  } catch (e) {
    return c.json(
      {
        ok: false,
        service: "gouxiangdb-api",
        version: "0.1.0",
        db: "error",
        error: String(e),
      },
      503,
    );
  }
});