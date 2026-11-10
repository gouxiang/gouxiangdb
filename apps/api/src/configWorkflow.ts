// apps/api/src/configWorkflow.ts
// 自研工作流引擎总门 GX_WORKFLOW_ENGINE 的解析纯函数——从 config 体系拆出
// （同 configSync.ts / configSignup.ts / configM5Search.ts 先例：纯函数、无 db/Hono 副作用，可表驱动单测）。
//
// 语义（**默认关闭，fail-closed**，与 configSync 同口径）：
//   未设置 / 空值 / 纯空白 / 除 on|true|1 之外的任何值（含拼写笔误如 opn、yes、0）= 关闭；
//   只有显式 on / true / 1（大小写不敏感、忽略首尾空白，故 "ON"/" On " 也开）= 开启。
//
// 为什么默认关、笔误也关：工作流引擎是一套会新增 workflow_defs/runs/approvals 三表写入、
// 并对外暴露工作流 API 与后台 runtime 的大能力。单机/飞牛/NAS 现网升级后必须与旧版
// 【逐字节一致】——不该因为部署时多写了一个没人认得的变量就悄悄打开整套工作流面。
// 把一次拼错（如 GX_WORKFLOW_ENGINE=opn）解读成「关」，代价只是工作流端点返回明确的
// 404 WORKFLOW_DISABLED，运维一眼能定位；解读成「开」则会在无人预期的情况下开始写
// workflow_* 表、启动 runtime、暴露工作流 API，事后很难察觉。需求 #1296 刀 A 明确默认 off。
//
// 为什么做成「运行时 per-request 读 env」而非启动期快照：
//   1. config 对象是 Object.freeze 的启动快照，测试无法在同一进程内切换；用纯函数读 env
//      可让测试在开关开/关两态下直接对拍（同 configSync / configSignup / configM5Search 纪律）。
//   2. 运维调整 env 后无需重启即生效（路由恒挂载，由组首中间件 per-request 判定，
//      与 /api/v1/sync、/api/v1/search「恒挂载 + 请求期闸门，off 落 404」同款，避免开关关死救不回来）。
//   3. 关键红线不变：off 时工作流组首中间件在【任何 DB 访问之前】短路 404，因此不会写任何
//      workflow_* 表、不启动 runtime、不建额外连接，旧行为零变化。

/** 开放态字面量集合（小写比较）；不在此集合内一律关闭。 */
const WORKFLOW_OPEN_VALUES = new Set(["on", "true", "1"]);

/**
 * 纯函数：原始 env 值 -> 工作流引擎是否开启。
 * 默认关闭（undefined / 空串 / 未知值都算关）；仅精确小写 on/true/1 为开。
 */
export function parseWorkflowEngineFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return WORKFLOW_OPEN_VALUES.has(raw.trim().toLowerCase());
}

/**
 * 运行时读 env（不进 config 启动快照）：工作流组首中间件每次请求判定，
 * 测试亦可在进程内通过设置/清除 GX_WORKFLOW_ENGINE 切换开关。
 */
export function workflowEngineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseWorkflowEngineFlag(env.GX_WORKFLOW_ENGINE);
}
