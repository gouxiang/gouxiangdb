// 官方商业授权客户端契约（beta.2 授权接入）：前端与 BFF（/api/license/*）共用唯一真源。
//
// 后端实现：apps/api/src/routes/license.ts（BFF）、apps/api/src/domain/license/*（领域）。
// 立场（信任边界铁律）：前端只渲染后端给的 verdict/seats；任何验签/指纹/版本/时钟失败，
// 后端都 fail-safe 回落免费 5 人档，绝不出现"无限版"（seats=null 仅 mode=off 的 bypassed）。

/** 三态门控：off=零出网零闸门（默认）；verify=通电只提示不拦；enforce=两道闸门真收敛。 */
export type LicenseMode = "off" | "verify" | "enforce";

/** 七态状态机裁决（中文标签由后端 verdictLabel 给，前端不自行映射）。 */
export type LicenseVerdict =
  | "bypassed"
  | "free"
  | "grandfathered"
  | "licensed"
  | "grace"
  | "expired"
  | "invalid";

/** GET /api/license/status 读模型。available=false 表示授权子系统未启用（mode=off/未 boot）。 */
export interface LicenseStatusDTO {
  /** 授权 BFF 是否可用（运行时已启动且 mode!=off）。off 时其余字段为下面的兜底值。 */
  available: boolean;
  mode: LicenseMode | "off";
  verdict: LicenseVerdict;
  /** 裁决中文短标签（后端唯一用词，前端直出）。 */
  verdictLabel: string;
  /** 单据席位数；null=无限（仅 bypassed/off）。免费/失效回落 5。 */
  seats: number | null;
  /** 当前占席（ACTIVE+INVITED）；off 时为 null。 */
  usedSeats: number | null;
  /** 当前登录成员是否管理员（owner/admin）：仅用于管理区 UI 显隐，非安全边界。 */
  isAdmin: boolean;
  /** 管理员自报邮箱（心跳字段分级/挂起页联系用），未设置为 null。 */
  adminEmail: string | null;
  /** 团队名（授权单据 licensedTo 或自报 orgName）。 */
  orgName: string | null;
  /** 授权对象名称（单据 licensedTo）。 */
  licensedTo: string | null;
  /** 单据到期 epoch 秒。 */
  expiresAt: number | null;
  /** 单据版本号（防重放高水位）。 */
  version: number | null;
  /** 三路冗余"曾商用"事实。 */
  everCommercial: boolean;
  /** 设备软指纹前 12 hex（仅展示/核对）。 */
  fingerprintShort: string;
  /**
   * 当前授权中心基址（可能已随签名信封迁移）。
   * 仅作机器字段保留，前端一律不渲染（避免让用户感觉被监控）。
   */
  baseUrl: string;
  /** 最近一次心跳是否在新鲜窗口内成功（在线 / 离网）。 */
  online: boolean;
  /** 最近一次【成功】心跳 epoch 毫秒；从未成功为 null。 */
  lastHeartbeatAt: number | null;
  /** 最近一次心跳尝试 epoch 毫秒（无论成败）；从未尝试为 null。 */
  lastAttemptAt: number | null;
  /** 是否有一次心跳正在进行（「立即同步」按钮转圈/互斥用）。 */
  syncing: boolean;
  /** 本机部署标识（离线申请码用）；拿不到为 null。 */
  deploymentId: string | null;
  /** 平台字面量（如 darwin/linux/win32）；拿不到为 null。 */
  platform: string | null;
  /**
   * 完整设备指纹（仅管理员返回，用于把指纹报给官方后台直绑）。
   * 非管理员响应不含该键；UI 复制引导只对管理员出现。
   */
  fingerprint?: string;
  /** 反馈角标（未读/未完工单数）。 */
  feedback: LicenseFeedbackBadge;
}

/**
 * POST /api/license/sync 结果（免输入「立即同步」：仅管理员）。
 * 与心跳接收链同口径：拒绝时 HTTP 200、ok=false、带 rejected 码；网络/网关错走 error/status。
 * 顺带回最新裁决，前端成功后无需再等一次 30s 轮询即可刷新头卡。
 */
export interface LicenseSyncResultDTO {
  ok: boolean;
  status: number;
  error: string | null;
  /** 接收链拒绝原因（KID_MISMATCH/BAD_SIGNATURE/FINGERPRINT_MISMATCH/VERSION_ROLLBACK/…）。 */
  rejected: string | null;
  verdict: LicenseVerdict;
  verdictLabel: string;
  /** 单据席位数；null=无限。 */
  seats: number | null;
  /** 同步后在线/离网裁决。 */
  online: boolean;
  lastHeartbeatAt: number | null;
}

export interface LicenseFeedbackBadge {
  unread: number;
  open: number;
}

/** activate/refresh/import-offline 的统一结果（接收链拒绝时 HTTP 仍 200、ok=false、带 rejected 码）。 */
export interface LicenseOutcomeDTO {
  ok: boolean;
  status: number;
  error: string | null;
  /** 接收链拒绝原因（KID_MISMATCH/BAD_SIGNATURE/FINGERPRINT_MISMATCH/VERSION_ROLLBACK/…）。 */
  rejected: string | null;
}

/** POST /api/license/contact 请求体（仅管理员）。 */
export interface LicenseContactInput {
  adminEmail?: string;
  orgName?: string;
}

/**
 * POST /api/license/activate 请求体（licenseKey 与 pairCode 二选一或同带）。
 * @deprecated 客户端 UI 已移除密钥/配对码手输入口（首次激活只走后台直绑 + 心跳自动下发，
 * 或离线应答码）。后端端点暂保留兼容旧包，前端不再调用。
 */
export interface LicenseActivateInput {
  licenseKey?: string;
  pairCode?: string;
}

/**
 * 离线「申请码」载荷：纯前端组装后 base64url 编码，交官方换取应答码（不产生任何网络请求）。
 * 字段对齐授权中心 offline-service：v/fingerprint/deploymentId/platform/nonce/requestedAt，
 * clientVersion 选带。
 */
export interface LicenseOfflineRequestPayload {
  v: 1;
  fingerprint: string;
  deploymentId?: string | null;
  platform?: string | null;
  nonce: string;
  /** 申请时刻 epoch 秒。 */
  requestedAt: number;
  clientVersion?: string;
}

/** POST /api/license/import-offline 请求体（离线应答码 base64url）。 */
export interface LicenseImportInput {
  code: string;
}

/** 闸门②：登录态被软挂起时后端 403 的机器码（全局错误收口据此渲染挂起页）。 */
export const LICENSE_SEAT_SUSPENDED_CODE = "LICENSE_SEAT_SUSPENDED";

/** 闸门①：新增账号满员被拦时后端 403 的机器码（据此弹"第 6 人"拦截对话框）。 */
export const LICENSE_SEAT_LIMIT_CODE = "LICENSE_SEAT_LIMIT";

/** 挂起 403 体（apps/api middleware/licenseSeatGate）。 */
export interface LicenseSuspendedErrorBody {
  error: string;
  code: typeof LICENSE_SEAT_SUSPENDED_CODE;
  verdict: Extract<LicenseVerdict, "expired" | "invalid">;
  contactEmail: string | null;
}
