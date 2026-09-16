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
