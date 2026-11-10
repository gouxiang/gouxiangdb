// /api/local-sync：本机侧车【定时同步引擎】只读状态端点（供前端轮询同步中心横幅/抽屉）。
// 设计权威：docs/design/2026-10-node-mode/DESIGN-OFFLINE-SYNC.md（离线优先双向同步，beta.2 B2）。
//
// ★ 挂载纪律：刻意挂在 /api/local-sync，【绝不挂进 /api/v1/sync 组】——后者是本节点作为【服务端】
//   对其它设备暴露的同步面（GX_SYNC_SERVER 门）；本端点反映的是本机作为【副本/侧车】的引擎态
//   （GX_OFFLINE_REPLICA + GX_REPLICA_REMOTE_URL 门）。两个角色/开关互相独立，不可共用一个门。
//   本地冲突裁决（conflicts 列表/retry/discard/resolve）在独立文件 routes/localSyncProxy.ts，
//   由 app.ts 挂到 /api/local-sync/conflicts（本文件的 localSyncRoutes 挂 /api/local-sync）。
//   本文件暴露 GET /status（只读）+ POST /sync-now（同步触发一轮）：后者只调用引擎 runReplicaSyncOnce()，
//   真正的写库发生在引擎内部经 withWriteTx 串行执行，端点自身不直接写任何表；不改变 fail-closed 门控。
//
// 可达性（默认关闭，fail-closed）：与服务端同步面同款「恒挂载 + 请求期闸门」——
//   路由恒挂到 mount，但组首中间件每次请求现场解析 replicaSyncConfig()：
//     GX_OFFLINE_REPLICA 未精确开 或 GX_REPLICA_REMOTE_URL trim 空（出厂默认）
//     -> 在【任何 DB 访问之前】直接 404 SYNC_DISABLED；默认安装零额外读、不暴露同步能力。
//   只有配置齐全（与 startReplicaSync 的启动判定同一真源）才继续鉴权与取数。
//
// 鉴权：requireActiveUser（resolveActiveAuth 同时认 Authorization: Bearer 与 X-GX-Token 两头，
//   飞牛 CGI 网关吞 Authorization 时前端走 X-GX-Token）。GET /status 纯只读不触发同步；
//   POST /sync-now 仅触发引擎跑一轮（引擎内部经 withWriteTx 串行写），复用组首两道闸、不另加门。

import fs from "node:fs";
import { Hono } from "hono";
import { config } from "../config.js";
import { replicaSyncConfig } from "../configReplica.js";
import { offlineNodeId } from "../configOfflineReplica.js";
import { HttpError } from "../httpError.js";
import { requireActiveUser } from "../middleware/authActive.js";
import { prisma } from "../db.js";
import { replicaSyncRuntimeStatus, runReplicaSyncOnce } from "../domain/sync/replicaSyncRuntime.js";

export const localSyncRoutes = new Hono();

// ① 总门：配置不齐全（默认）即 404，短路在鉴权/DB 之前。判定与 startReplicaSync 完全同源。
localSyncRoutes.use("*", async (_c, next) => {
  if (!replicaSyncConfig()) {
    throw new HttpError(404, "同步服务未启用", "SYNC_DISABLED");
  }
  return next();
});

// ② 鉴权：登录且账号 ACTIVE（X-GX-Token / Authorization 均收）。
localSyncRoutes.use("*", requireActiveUser);

/**
 * 本地 SQLite 库文件占用字节。DATABASE_URL 形如 `file:/abs/app.db`：剥 `file:` 前缀与 query/hash
 * 后 statSync 取 size；非 file: URL、空路径、解析失败、文件不存在/不是普通文件一律 0。
 * 纯只读、不递归目录；接收 databaseUrl 入参便于表驱动单测（端点传 config.databaseUrl）。
 */
export function localDatabaseBytes(databaseUrl: string): number {
  try {
    if (!databaseUrl || !databaseUrl.startsWith("file:")) return 0;
    const filePath = databaseUrl.slice("file:".length).split(/[?#]/, 1)[0]!;
    if (!filePath) return 0;
    const st = fs.statSync(filePath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

// ③ 引擎只读状态。纯 GET：只做计数/列表/文件 stat 读，不触发一轮同步、不写任何表。
localSyncRoutes.get("/status", async (c) => {
  const rt = replicaSyncRuntimeStatus();
  const nodeId = offlineNodeId();

  // 发件箱待发 / 冲突 / 失权隔离计数（失权隔离在副本侧就是本地 outbox 的 quarantined 行；
  // 均按当前 nodeId 收口，与引擎推送同源）。
  const [pendingOutbox, conflictCount, quarantinedCount, rows] = await Promise.all([
    prisma.localOutbox.count({ where: { nodeId, status: "pending" } }),
    prisma.localOutbox.count({ where: { nodeId, status: "conflict" } }),
    prisma.localOutbox.count({ where: { nodeId, status: "quarantined" } }),
    prisma.replicaState.findMany({ where: { nodeId }, orderBy: { remoteBaseId: "asc" } }),
  ]);

  // 顶层时间取各副本中的最近一次（无副本/从未同步则为 null）；bases 逐 base 各带自己的时间。
  let lastPulledAt: Date | null = null;
  let lastPushedAt: Date | null = null;
  // 浏览器在本地侧车语境操作的是【本地库 id】：逐个 localBaseId 取本地 bases.name（查不到给 null，
  // 绝不因库行已删/纯树游标而 500）。
  const bases: Array<{
    id: string;
    name: string | null;
    lastPulledAt: Date | null;
    lastPushedAt: Date | null;
  }> = [];
  for (const r of rows) {
    if (r.lastPulledAt && (!lastPulledAt || r.lastPulledAt > lastPulledAt)) lastPulledAt = r.lastPulledAt;
    if (r.lastPushedAt && (!lastPushedAt || r.lastPushedAt > lastPushedAt)) lastPushedAt = r.lastPushedAt;
    let name: string | null = null;
    try {
      const base = await prisma.base.findUnique({ where: { id: r.localBaseId }, select: { name: true } });
      name = base?.name ?? null;
    } catch {
      name = null;
    }
    bases.push({ id: r.localBaseId, name, lastPulledAt: r.lastPulledAt, lastPushedAt: r.lastPushedAt });
  }

  return c.json({
    // 能走到这里说明配置齐全（总门已过），故 enabled 恒 true；off 态在上面直接 404。
    enabled: true,
    running: rt.running,
    inFlight: rt.inFlight,
    stage: rt.stage,
    nodeId,
    lastPulledAt,
    lastPushedAt,
    pendingOutbox,
    conflictCount,
    quarantinedCount,
    localBytesUsed: localDatabaseBytes(config.databaseUrl),
    lastError: rt.lastError,
    lastRunAt: rt.lastRunAt,
    bases,
  });
});

// ④ 手动触发一轮：直接 await runReplicaSyncOnce()（不 sleep、不另起定时器）。复用组首两道闸
//    （配置门 + requireActiveUser），不新增任何门；端点自身不直接写库，写库由引擎内部 withWriteTx 串行完成。
//    引擎未启动（未 startReplicaSync）时 runReplicaSyncOnce 返回 false（triggered=false），仍 200 回当前态。
localSyncRoutes.post("/sync-now", async (c) => {
  const triggered = await runReplicaSyncOnce();
  const rt = replicaSyncRuntimeStatus();
  return c.json({
    triggered,
    running: rt.running,
    inFlight: rt.inFlight,
    stage: rt.stage,
    lastError: rt.lastError,
    lastRunAt: rt.lastRunAt,
  });
});
