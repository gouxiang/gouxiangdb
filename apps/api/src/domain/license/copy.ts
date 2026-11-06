/**
 * 授权文案唯一用词表（06-ERRORS-AND-COPY.md 为唯一真源）。
 * 后端错误消息、状态 DTO 与前端展示都从这里取，禁止在各处硬编码分叉。
 */

export const LICENSE_COPY = {
  // 新增账号闸（LICENSE_SEAT_LIMIT）
  seatLimitFree: "免费版最多 5 人。购买商业许可或输入已有密钥即可继续添加。",
  seatLimitGrandfathered: "本团队为升级前创建，现有成员不受影响；新增成员需要商业许可。",
  seatLimitCommercial: "商业许可席位已满，如需增加成员请续费扩容或联系官方。",
  // 登录态闸（LICENSE_SEAT_SUSPENDED）
  suspended:
    "商业许可已到期，当前账号暂被挂起。你的数据与账号均保留，管理员续费后将自动恢复。",
  // 信封异常 fail-safe
  verifyAnomaly: "授权校验异常，已按免费版运行。",
  // 激活错误（对齐服务端错误码）
  keyInvalid: "授权密钥无效，请核对后重试",
  revoked: "授权已被停用，请联系官方或购买新许可",
  pairCodeExpired: "配对码已过期，请向管理员索取新码",
  alreadyBound:
    "该授权已绑定另一台设备 / 本设备已绑定另一授权，如需更换请联系管理员",
  fingerprintMismatch: "本机与绑定信息不一致，如已换机请联系管理员换绑",
  notBound: "该授权尚未绑定实例，请先完成激活",
  // 反馈
  feedbackNetwork: "网络异常，稍后重试",
} as const;

export type LicenseCopyKey = keyof typeof LICENSE_COPY;

/** verdict -> 中文短标签（状态页用）。 */
export const VERDICT_LABEL: Record<string, string> = {
  bypassed: "未启用授权",
  free: "免费版",
  grandfathered: "升级前团队",
  licensed: "商业版已授权",
  grace: "商业版·宽限期",
  expired: "商业版已到期",
  invalid: "授权已停用",
};
