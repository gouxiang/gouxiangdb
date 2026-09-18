// apps/api/src/configSignup.ts
// 公开注册开关（GX_ALLOW_PUBLIC_SIGNUP）解析——从 config.ts 抽出的纯函数（node 内置依赖，
// 无 db/Hono），供 auth.ts 路由 per-request 读取，使运维改 env 后无需重启即生效判定
// （与 configAuthz.effectiveAuthzMode 同款「运行时读 env」纪律，纯函数便于单测）。
//
// 语义（0.1.7 新增，未设置即完全向后兼容）：
//   未设置 / 空值 / 除 off|false|0 之外的任何值 = 开放；
//   显式 off / false / 0（大小写不敏感、忽略首尾空白）= 关闭。
// 关闭只挡【非空库】的注册：users 表为空时首个账号引导必须永远可行，
// 否则新部署（含重装/回滚）会自举死锁——首用户自举见 domain/org/members.ts。

/** 关闭态字面量集合（小写比较）。 */
const CLOSED_VALUES = new Set(["off", "false", "0"]);

/** 纯函数：env → 公开注册是否开放（默认开放）。 */
export function publicSignupOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GX_ALLOW_PUBLIC_SIGNUP;
  if (raw === undefined) return true;
  return !CLOSED_VALUES.has(raw.trim().toLowerCase());
}
