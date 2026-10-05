// apps/api/src/domain/queryPlan/connection.ts
// sidecar 读执行器的进程级只读连接单例（与 S2 raw 网关同源库文件，独立只读连接，
// WAL 下不阻塞写者）。测试不使用单例（直接注入临时库连接）。

import Database from "better-sqlite3";
import { defaultDatabaseFile } from "../../db/rawRead.js";
import { createSidecarQuerier, type SidecarQuerier } from "./sidecarQuery.js";
import { benchEnabled, instrumentDatabase } from "../../ops/benchMetrics.js";

let querier: SidecarQuerier | undefined;

/** 进程级 sidecar 只读 querier 单例（惰性打开，需库已迁移）。 */
export function getSidecarQuerier(): SidecarQuerier {
  if (!querier) {
    const raw = new Database(defaultDatabaseFile(), { readonly: true, fileMustExist: true });
    raw.pragma("busy_timeout = 5000");
    const db = benchEnabled() ? instrumentDatabase(raw) : raw;
    querier = createSidecarQuerier(db);
  }
  return querier;
}
