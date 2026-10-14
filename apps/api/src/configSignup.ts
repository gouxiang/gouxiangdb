// apps/api/src/configSignup.ts
// 公开注册开关（GX_ALLOW_PUBLIC_SIGNUP）解析——从 config.ts 抽出的纯函数（node 内置依赖，
// 无 db/Hono），供 auth.ts 路由 per-request 读取，使运维改 env 后无需重启即生效判定
// （与 configAuthz.effectiveAuthzMode 同款「运行时读 env」纪律，纯函数便于单测）。
//
// 语义（企业部署口径，fail-closed）：
//   未设置 / 空值 / 除 on|true|1 之外的任何值（含拼写笔误）= 关闭；
//   只有显式 on / true / 1（大小写不敏感、忽略首尾空白）= 开放。
// 为什么未知值也关闭：这是笔误/误配无法自发察觉的一侧。把一次拼错（如 "opne"）解读成
// 「开放」会让任意人自助注册进企业工作区，事后靠日志很难发现；解读成「关闭」的可观测
// 代价只是一条明确的 403 SIGNUP_CLOSED，运维一眼能定位。企业平台的账号建立/邀请统一
// 走管理员（/api/v1/org/members 的 invite_users / create_users），自注册不是必需路径。
//
// 关闭只挡【非空库】的注册：users 表为空时首个账号引导必须永远可行，
// 否则新部署（含重装/回滚）会自举死锁——见 auth.ts 的 SIGNUP_CLOSED 判定
// （count()===0 时放行）与 domain/org/members.ts 的 bootstrapFirstOwnerTx。

/** 开放态字面量集合（小写比较）；不在此集合内一律关闭。 */
const OPEN_VALUES = new Set(["on", "true", "1"]);

/** 纯函数：env → 公开注册是否开放（默认关闭，fail-closed）。 */
export function publicSignupOpen(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GX_ALLOW_PUBLIC_SIGNUP;
  if (raw === undefined) return false;
  return OPEN_VALUES.has(raw.trim().toLowerCase());
}

/**
 * 纯函数：app_settings KV「auth.public_signup」原始值 → 后台自主注册开关是否开放。
 *
 * 与 env 侧刻意不同的口径——KV 侧只认字面量 "on"（trim 后小写比较）：
 *   - KV 行只由后台 PATCH /api/admin/branding 写入（signupOpen true→"on" / false→"off"），
 *     不存在运维手写 env 时 "true"/"1"/"yes" 之类的多字面量宽容需求；
 *   - 只认单一明确字面量可避免「两套开关语义集合混淆」：若 KV 也接受 "true"/"1"，
 *     读代码的人必须时刻区分当前值来自 env 还是 KV 才能判断是否开放；
 *   - fail-closed：缺行（null/undefined）、空串、"off"、以及任何意外值一律 false，
 *     与全新/升级实例默认关闭、行为与历史一致的口径吻合。
 */
export function publicSignupAllowedByKv(raw: string | null | undefined): boolean {
  return typeof raw === "string" && raw.trim().toLowerCase() === "on";
}
