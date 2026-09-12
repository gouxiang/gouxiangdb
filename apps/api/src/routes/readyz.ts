// apps/api/src/routes/readyz.ts
// GET /readyz — readiness：串行五探针，全过 200，任一失败 503。
// 响应只含布尔/短码/版本/迁移名，绝不含绝对路径、异常堆栈。

import { Hono } from "hono";
import {
  createDefaultDeps,
  runChecks,
  type CheckName,
  type ReadinessDeps,
} from "../ops/readiness.js";

const CHECK_NAMES: CheckName[] = [
  "dbPing",
  "dbWritable",
  "migrations",
  "uploadsWritable",
  "disk",
];

export interface ReadinessHttp {
  httpStatus: 200 | 503;
  body: Record<string, unknown>;
}

// 可注入依赖的纯评估（便于单测通过/失败两态）。
export async function assessReadiness(deps: ReadinessDeps): Promise<ReadinessHttp> {
  const report = await runChecks(deps);
  if (report.status === "ready") {
    return {
      httpStatus: 200,
      body: {
        status: report.status,
        service: report.service,
        version: report.version,
        checks: report.checks,
        migration: report.migration,
      },
    };
  }
  // 失败：通过项保持 true，失败项给短码字符串；error 仅短码，绝不回传异常原文。
  const checksOut = { ...report.checks } as Record<CheckName, boolean | string>;
  let firstFailure: string | null = null;
  for (const name of CHECK_NAMES) {
    if (!report.checks[name]) {
      const code = report.failureCodes[name] ?? "FAIL";
      checksOut[name] = code;
      firstFailure ??= code;
    }
  }
  return {
    httpStatus: 503,
    body: {
      status: report.status,
      service: report.service,
      version: report.version,
      checks: checksOut,
      migration: report.migration,
      error: firstFailure ?? "FAIL",
    },
  };
}

export const readyz = new Hono();

readyz.get("/", async (c) => {
  const deps = createDefaultDeps();
  try {
    const r = await assessReadiness(deps);
    return c.json(r.body, r.httpStatus);
  } finally {
    deps.dispose();
  }
});
