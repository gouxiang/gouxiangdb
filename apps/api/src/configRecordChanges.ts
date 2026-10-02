// apps/api/src/configRecordChanges.ts
// 记录变更历史（数据日志）写入开关 GX_RECORD_CHANGES 的解析纯函数——从 config.ts 拆出
// （同 configAuthz.ts / configM5Search.ts 先例，保 config.ts 单文件行数门禁）。
// 仅依赖字符串处理，无 db/Hono/网络副作用，可表驱动单测。
//
// 语义（**默认关闭**，fail-closed）：
//   未设置 / 空串 / 除精确小写 "on" 之外的任何值 = 不写一行；
//   只有显式 "on" = 在记录 create/update/delete/restore 的主写事务内旁路追加一行历史。
//
// 为什么默认关闭：这是一张【只增不删、随每次记录写放大】的表，开在既有库上会持续吃
// 磁盘并给每条写路径加一次 INSERT。新能力默认旁路、需要时由运维显式打开，符合本项目
// 「增量、旁路、默认可关、不动旧数据」的一贯纪律；关闭时写路径零额外 IO（一次布尔判断
// 直接 return），读端点仍然可用（只是没有历史可返回，回空列表）。
//
// 为什么严格只认小写 "on"（不接受 "ON"/"On"/"true"/"1"）：与 parseM5SearchFlag 同款
// 纪律，笔误一律回落到"关"，事后可观测代价只是"没记日志"，而不是"悄悄开始写表"。

/**
 * 纯函数：原始 env 值 -> 是否开启记录变更历史写入。
 * 仅精确小写 "on" 为真，其余（含 undefined）为假。
 */
export function parseRecordChangesFlag(raw: string | undefined): boolean {
  return raw?.trim() === "on";
}

/**
 * 运行时读 env（不进 config 启动快照）：运维改 env 后无需重启即生效，
 * 与 configSignup.publicSignupOpen / configAuthz.effectiveAuthzMode 同款纪律，
 * 也让测试能在进程内切换开关（config 对象是 Object.freeze 的，不可写）。
 */
export function recordChangesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseRecordChangesFlag(env.GX_RECORD_CHANGES);
}
