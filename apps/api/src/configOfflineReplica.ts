// apps/api/src/configOfflineReplica.ts
// 「本机内核作为某节点离线副本」开关 GX_OFFLINE_REPLICA 的解析纯函数——与 configSync.ts 同范式：
// 纯函数、无 db/Hono 副作用、调用时读 env（非启动期冻结快照），可表驱动单测、可进程内切换。
//
// 与 GX_SYNC_SERVER 的关系（两个互相独立的角色，可各自 on/off）：
//   - GX_SYNC_SERVER：本节点作为【服务端】，对其它设备暴露 /api/v1/sync/*、维护服务端 oplog。
//   - GX_OFFLINE_REPLICA：本机内核作为某节点的【离线副本/侧车】，在本地直写时额外同事务登记
//     local_outbox（待推送操作）并推进本地版本钟，供未来推送引擎把本地写发到服务端。
//   同一进程可同时为真（如自托管节点既当服务端又持有本地副本）：两条记账各写各的、不共享
//   clientOpId（服务端切面 srv-*，副本切面 local-*），互不影响。
//
// 语义（**默认关闭，fail-closed**，与 configSync 同口径）：未设置 / 空串 / 除精确小写
// on|true|1 之外任何值（含笔误、大写）= 关闭。默认安装即便升级也与旧版逐字节一致——不多写
// local_outbox、不额外推进本地钟；只有显式开启才激活 record 轨离线捕获。

/** 开放态字面量集合（精确小写）；不在此集合内一律关闭。 */
const OFFLINE_OPEN_VALUES = new Set(["on", "true", "1"]);

/** 节点 id 缺省值（单机本地节点；未来由壳注入安装实例/远端节点 id 覆盖）。 */
export const OFFLINE_DEFAULT_NODE_ID = "local";
/** 本地内核里代表「本机直写」的 clientId（未来 S3 安装实例 id 由壳注入覆盖）。 */
export const OFFLINE_DEFAULT_CLIENT_ID = "local-replica";

/**
 * 纯函数：原始 env 值 -> 是否启用离线副本捕获。默认关，仅精确小写 on/true/1 为开。
 * fail-closed 纪律与 configM5Search 一致：不 trim、不 toLowerCase——
 * "ON"/"On"/"on "/带空格或笔误一律判关（派工契约：见本文件头与 configReplica 测试）。
 */
export function parseOfflineReplicaFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return OFFLINE_OPEN_VALUES.has(raw);
}

/** 运行时读 env：record 直写切面在事务内调用判定，测试亦可进程内切换。 */
export function offlineReplicaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseOfflineReplicaFlag(env.GX_OFFLINE_REPLICA);
}

/** 目标节点 id：GX_OFFLINE_NODE_ID trim 后使用；启用副本但为空时回退 "local"。 */
export function offlineNodeId(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.GX_OFFLINE_NODE_ID?.trim();
  return v ? v : OFFLINE_DEFAULT_NODE_ID;
}

/** 本地直写 clientId：GX_OFFLINE_CLIENT_ID trim 后使用；为空回退 "local-replica"。 */
export function offlineClientId(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.GX_OFFLINE_CLIENT_ID?.trim();
  return v ? v : OFFLINE_DEFAULT_CLIENT_ID;
}
