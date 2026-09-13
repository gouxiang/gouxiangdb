// apps/api/src/domain/queryPlan/connection.ts
// sidecar 读执行器的进程级只读连接单例（与 S2 raw 网关同源库文件，独立只读连接，
// WAL 下不阻塞写者）。测试不使用单例（直接注入临时库连接）。

import Database from "better-sqlite3";
import { defaultDatabaseFile, closeRawReader } from "../../db/rawRead.js";
import { createSidecarQuerier, type SidecarQuerier } from "./sidecarQuery.js";
import { benchEnabled, instrumentDatabase } from "../../ops/benchMetrics.js";

let querier: SidecarQuerier | undefined;
let conn: Database.Database | undefined;

/** 进程级 sidecar 只读 querier 单例（惰性打开，需库已迁移）。 */
export function getSidecarQuerier(): SidecarQuerier {
  if (!querier) {
    const raw = new Database(defaultDatabaseFile(), { readonly: true, fileMustExist: true });
    raw.pragma("busy_timeout = 5000");
    conn = raw;
    const db = benchEnabled() ? instrumentDatabase(raw) : raw;
    querier = createSidecarQuerier(db);
  }
  return querier;
}

/** 优雅停机/测试：关闭 sidecar 只读连接（同时关 S2 raw 单例，保停机干净）。 */
export function closeSidecarRead(): void {
  querier = undefined;
  conn?.close();
  conn = undefined;
  closeRawReader();
}
