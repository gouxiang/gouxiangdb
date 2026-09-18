// apps/api/src/configM5Search.ts
// M5 统一检索总门（GX_M5_SEARCH）解析纯函数——从 config.ts 拆出（同 configAuthz.ts 先例，
// 保 config.ts 单文件行数门禁）。仅依赖字符串处理，无 db/Hono/网络副作用，可表驱动单测。
//
//   off（默认，含未设置/空串/未知值/大小写不符）= 不挂 /api/v1/search、不起 indexer worker、
//       不建 search.db 连接，旧 /api/search 字节不变；
//   shadow = 挂载路由，新链路与旧 /api/search 对拍（S7 起接线，结果只记日志不返回）；
//   on     = 挂载路由，新链路对外（S7 起接线）。
//
// 严格取值：仅接受 trim 后的精确小写 "shadow"/"on"；"ON"/"On" 等一律保守回 off，
// 与 M1/M4 各 flag 的未知值保守默认纪律一致。

export type M5SearchFlag = "off" | "shadow" | "on";

/**
 * 纯函数：原始 env 值 -> 三态门。undefined/空白/未知/大小写不符均回 "off"。
 * 注意与 toLowerCase() 解析刻意不同：只认小写，大写 "ON" 判 off（派工要求）。
 */
export function parseM5SearchFlag(raw: string | undefined): M5SearchFlag {
  const v = raw?.trim();
  if (v === "shadow" || v === "on") return v;
  return "off";
}

/**
 * GX_M5_SHADOW_STRICT（§6）：shadow 对拍严格门。仅精确小写 "on" 启用；
 * 启用后新链路与旧 /api/search 在可比集上 drift 非 0 即让该请求失败。
 * 与 parseM5SearchFlag 同款严格小写纪律（"ON"/"On" 一律 false）。
 */
export function parseM5ShadowStrict(raw: string | undefined): boolean {
  return raw?.trim() === "on";
}

/**
 * GX_SEARCH_WORKER（计划 §4 R6 / M7 回滚面 R6）：内嵌索引 worker 排障开关。
 *   - 显式 "off" = 不起 worker（即使 GX_M5_SEARCH=on）：主应用与检索读路径不受损，
 *     outbox（change_events）只积压不消化，恢复后由 worker 追平；
 *   - 其余（未设 / "on" / 任何其它值）= on。
 * 与 config.ts 各 flag 同款 "`!== 'off'`" 读法（GX_RATE_LIMIT / GX_ENTERPRISE_ORG 同族），
 * 且不引入第四种三态：这个开关只承担"排障时一键停写派生库"一件事。
 */
export function parseSearchWorkerFlag(raw: string | undefined): boolean {
  return raw?.trim() !== "off";
}
