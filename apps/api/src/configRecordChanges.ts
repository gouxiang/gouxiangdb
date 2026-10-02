// apps/api/src/configRecordChanges.ts
// 记录变更历史（数据日志）写入开关 GX_RECORD_CHANGES 的解析纯函数——从 config.ts 拆出
// （同 configAuthz.ts / configM5Search.ts 先例，保 config.ts 单文件行数门禁）。
// 仅依赖字符串处理，无 db/Hono/网络副作用，可表驱动单测。
//
// 语义（**默认开启**，fail-open；仍保留显式关闭的逃生门）：
//   未设置 / 空串 / 除精确小写 "off"|"false"|"0" 之外的任何值 = 正常写历史；
//   只有显式 "off"（运维友好再认 "false" / "0"）= 不写一行。
//
// 为什么是默认开启而不是默认关闭：
//   1. **变更历史不可回溯补写**。它记的是「写前/写后」两份字段快照，写完之后旧值就消失了，
//      没有任何数据源能把它补回来。默认关 = 用户点开「查看日志」永远是空列表，功能在用户
//      手里是死的；哪天想起来要开，之前的每一次改动已经永久丢失。
//   2. 戴总的需求原文是"点击弹窗展示日志"——交付的是一个**点开就有内容**的功能，
//      不是一个需要运维先去改 .env 才工作的功能。
//   3. 成本侧的那半个理由仍然成立（这是一张只增不删、随每次记录写放大的表，开在既有库上
//      会持续吃磁盘、给每条写路径加一次 INSERT），所以显式 "off" 的逃生门必须留着——
//      磁盘吃紧或压测时可一键关掉，符合「增量、旁路、可回滚」的一贯纪律。
//   4. 写侧不成为业务写的失败点：写入挂在既有主写事务内，且 store.ts 对整段做了 try/catch
//      兜底（异常只 console.warn 一次后吞掉），日志侧出错最多是"这条没记"，绝不会让
//      「保存记录」变成 500。项目硬约束是"不得对已产生的真实数据造成破坏性影响"，
//      业务写被旁路组件拖死正是要防的那种情形。
//
// 为什么关闭值也只认小写：与 parseM5SearchFlag 同款严格纪律。反过来这里笔误（如 "OFF"）
// 的代价是"照常写表"而不是"悄悄停写"——后者才会造成不可回溯的历史空洞，故取前者。

/** 关闭态字面量集合（小写比较）；不在此集合内一律开启。 */
const OFF_VALUES = new Set(["off", "false", "0"]);

/**
 * 纯函数：原始 env 值 -> 是否开启记录变更历史写入。
 * 默认开启（undefined / 空串 / 未知值都算开）；仅精确小写 off/false/0 为关。
 */
export function parseRecordChangesFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !OFF_VALUES.has(raw.trim().toLowerCase());
}

/**
 * 运行时读 env（不进 config 启动快照）：运维改 env 后无需重启即生效，
 * 与 configSignup.publicSignupOpen / configAuthz.effectiveAuthzMode 同款纪律，
 * 也让测试能在进程内切换开关（config 对象是 Object.freeze 的，不可写）。
 */
export function recordChangesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseRecordChangesFlag(env.GX_RECORD_CHANGES);
}
