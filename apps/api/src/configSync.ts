// apps/api/src/configSync.ts
// 服务端离线同步能力总门 GX_SYNC_SERVER 的解析纯函数——从 config.ts 拆出
// （同 configSignup.ts / configM5Search.ts 先例：纯函数、无 db/Hono 副作用，可表驱动单测）。
//
// 语义（**默认关闭，fail-closed**，与 configSignup 同口径）：
//   未设置 / 空值 / 纯空白 / 除 on|true|1 之外的任何值（含拼写笔误如 opn、yes、0）= 关闭；
//   只有显式 on / true / 1（大小写不敏感、忽略首尾空白，故 "ON"/" On " 也开）= 开启。
//
// 为什么默认关、笔误也关：离线同步是一套会新增 oplog/版本表写入、并对外暴露 /api/v1/sync/*
// 的大能力。单机/飞牛/NAS 现网升级后必须与旧版【逐字节一致】——不该因为部署时多写了一个
// 没人认得的变量就悄悄打开整套同步面。把一次拼错（如 GX_SYNC_SERVER=opn）解读成「关」，
// 代价只是同步端点返回明确的 404 SYNC_DISABLED，运维一眼能定位；解读成「开」则会在无人
// 预期的情况下开始写 sync_* 表、暴露同步 API，事后很难察觉。设计 §11.1 明确默认 off。
//
// 为什么做成「运行时 per-request 读 env」而非启动期快照：
//   1. config 对象是 Object.freeze 的启动快照，测试无法在同一进程内切换；用纯函数读 env
//      可让测试在开关开/关两态下直接对拍（同 configSignup / configM5Search 纪律）。
//   2. 运维调整 env 后无需重启即生效（路由恒挂载，由组首中间件 per-request 判定，
//      与 /api/v1/search「恒挂载 + 请求期闸门，off 落 404」同款，避免开关关死救不回来）。
//   3. 关键红线不变：off 时同步组首中间件在【任何 DB 访问之前】短路 404，因此不会写任何
//      sync_* 表、不建额外连接，旧行为零变化。

/** 开放态字面量集合（小写比较）；不在此集合内一律关闭。 */
const SYNC_OPEN_VALUES = new Set(["on", "true", "1"]);

/**
 * 纯函数：原始 env 值 -> 服务端同步面是否开启。
 * 默认关闭（undefined / 空串 / 未知值都算关）；仅精确小写 on/true/1 为开。
 */
export function parseSyncServerFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return SYNC_OPEN_VALUES.has(raw.trim().toLowerCase());
}

/**
 * 运行时读 env（不进 config 启动快照）：同步组首中间件每次请求判定，
 * 测试亦可在进程内通过设置/清除 GX_SYNC_SERVER 切换开关。
 */
export function syncServerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseSyncServerFlag(env.GX_SYNC_SERVER);
}
