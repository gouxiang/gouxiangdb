// 系统更新面板：全部中文文案 / 错误码映射 / 展示口径的唯一收口（DESIGN §6.1 错误表、§7.2 布局）。
//
// 纪律：
//   - 面板组件不写字面错误文案，一律从这里取，保证和后端错误表逐字对齐；
//   - 错误码映射 fail-closed：未识别的 5xx/未知码给中性兜底，绝不透出上游错误体或内网细节；
//   - 通道名只做「已知 id → 中文名」展示，未知 id 不猜（后端标 unknown 才说「未识别」）。

// ---------------------------------------------------------------------------
// 静态文案
// ---------------------------------------------------------------------------

export const UPDATE_COPY = {
  title: "系统更新",
  subtitle: "检查是否有新版本，并下载与当前部署方式匹配的安装包。",
  check: "检查更新",
  recheck: "重新检查",
  retry: "重试",
  checking: "正在检查更新…",
  idleHint: "检查不会影响正在使用的服务；发现新版本后由您手动下载并按指引安装。",
  latestHint: "当前已是最新版本",
  availableTitle: "发现新版本",
  contactSupport: "当前版本过旧，无法直接升级，请联系支持获取升级方案",
  downloadPrepare: "正在准备下载…",
  downloadPrefix: "下载",
  downloadTicketFailed: "下载准备失败，请稍后重试",
  newerSchema: "更新清单版本较新，部分信息可能无法完整展示，建议升级后再查看。",
  versionAbnormal: "版本标识异常",
  channelUnknown: "未识别的部署方式",
  notChecked: "尚未检查",
  lastChecked: "上次检查时间",
  envTitle: "当前环境",
  envVersion: "当前版本",
  envChannel: "部署通道",
  envArch: "运行架构",
  releasePublishedAt: "发布时间",
  packageSize: "安装包大小",
  sha256: "SHA-256 校验值",
  copySha: "复制校验值",
  shaCopied: "校验值已复制",
  copyFailed: "复制失败，请手动选择文本复制",
  guideTitle: "手动安装指引",
  preUpgradeTitle: "升级前请注意",
  notesTitle: "更新说明",
  failedTitle: "检查失败",
  // ---- 方案 A：NAS 本地后台预缓存 ----
  prefetchHint:
    "安装包较大，直接在面板内下载可能因网关超时失败。可先让系统在后台把安装包下载到本机，完成后再下载会很快。",
  prefetchStart: "后台预下载",
  prefetchStarting: "正在启动后台预下载…",
  prefetchRunning: "后台预下载中…",
  prefetchReady: "已预下载到本机，可快速下载安装",
  prefetchFailed: "后台预下载失败，可重试或直接下载",
  prefetchStale: "本机预下载的不是当前版本，可重新预下载",
  prefetchRetry: "重新预下载",
  prefetchDownloadReady: "立即下载（本机秒取）",
  prefetchDownloadDirect: "直接下载",
  prefetchBusy: "已有其他预下载任务在进行，请等待其完成",
  prefetchStartedToast: "已开始后台预下载，可稍后回到本页查看进度",
} as const;

// ---------------------------------------------------------------------------
// 通道中文名（与后端 CHANNEL_* 已知 id 对齐；未知/unknown → 通用文案）
// ---------------------------------------------------------------------------

const CHANNEL_LABELS: Record<string, string> = {
  "fnos-fpk": "飞牛 fpk 成品包",
  "source-bare": "裸机源码部署",
  "desktop-client": "桌面客户端",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? UPDATE_COPY.channelUnknown;
}

/** 「linux / x64」形式；后端给的就是归一化值，原样拼接。 */
export function archLabel(platform: string, arch: string): string {
  return `${platform} / ${arch}`;
}

// ---------------------------------------------------------------------------
// 字节数人类化（MiB，保留 1 位小数；<1 MiB 显示 KiB）
// ---------------------------------------------------------------------------

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ISO 时间 → 本地时区 YYYY-MM-DD HH:mm；无法解析回退原串。
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// 错误码 → 中性中文（与 routes/v1/adminUpdate.ts 的 ERROR_MESSAGES 逐字对齐）
// ---------------------------------------------------------------------------

export const UPDATE_ERROR_MESSAGES: Record<string, string> = {
  UPDATE_SOURCE_UNCONFIGURED: "更新源尚未配置，请联系部署人员",
  UPDATE_SOURCE_AUTH: "更新源凭证无效，请联系部署人员",
  UPDATE_SOURCE_UNREACHABLE: "暂时无法连接更新服务，您可以稍后重试",
  UPDATE_SOURCE_TIMEOUT: "连接更新服务超时，请稍后重试",
  UPDATE_MANIFEST_INVALID: "更新清单暂时不可用，请联系支持",
  UPDATE_TICKET_INVALID: "下载链接已失效，请返回重新点击下载",
  UPDATE_NOT_AVAILABLE: "当前没有可下载的更新，请重新检查更新后再试",
  // 方案 A：后台预缓存稳定错误码（与 prefetch.ts 的 prefetchCode / 路由收敛逐字对齐）。
  PREFETCH_AUTH: "更新源凭证无效，请联系部署人员",
  PREFETCH_UNREACHABLE: "暂时无法连接更新服务，您可以稍后重试",
  PREFETCH_TIMEOUT: "下载长时间无进展已暂停，已保留进度，可重试续传",
  PREFETCH_CHECKSUM: "下载的安装包校验未通过，已丢弃，请重新预下载",
  PREFETCH_DISK: "本机存储空间不足或写入失败，请清理后重试",
  PREFETCH_BAD_STATE: "本地缓存状态异常，无法继续，请重新预下载",
};

/** 网络层 / 超时（前端 ApiTimeoutError 无 code）专用文案。 */
export const UPDATE_NETWORK_ERROR_MESSAGE = "网络异常，请检查连接后重试";
export const UPDATE_TIMEOUT_ERROR_MESSAGE = "连接更新服务超时，请稍后重试";
/** 403（非 owner）理论上分区不可见；直戳 API 时给中性提示。 */
export const UPDATE_FORBIDDEN_MESSAGE = "仅工作区所有者可以检查更新";
/** 兜底：不泄漏 body。 */
export const UPDATE_FALLBACK_ERROR_MESSAGE = "检查更新失败，请稍后重试";

/**
 * 把任意异常归一为面板可展示的中文短句。
 * @param getCode 取错误码的回调（ApiError.body.code），由 hooks 注入避免本文件依赖 client。
 */
export function updateErrorMessage(e: unknown, getCode: (e: unknown) => string | null): string {
  const code = getCode(e);
  if (code && UPDATE_ERROR_MESSAGES[code]) return UPDATE_ERROR_MESSAGES[code]!;
  const status = statusOf(e);
  if (status === 403) return UPDATE_FORBIDDEN_MESSAGE;
  if (status === 408 || code === "UPDATE_SOURCE_TIMEOUT") return UPDATE_TIMEOUT_ERROR_MESSAGE;
  if (status === 0) return UPDATE_NETWORK_ERROR_MESSAGE;
  return UPDATE_FALLBACK_ERROR_MESSAGE;
}

/** 从 ApiError 形态取 HTTP 状态（鸭子类型，不 import client 防循环）；非 ApiError → 0（网络层）。 */
function statusOf(e: unknown): number {
  if (e && typeof e === "object" && "status" in e) {
    const s = (e as { status?: unknown }).status;
    return typeof s === "number" ? s : 0;
  }
  return 0;
}

/** 从 ApiError 形态取 body（鸭子类型）。 */
function bodyOf(e: unknown): { code?: unknown; decision?: unknown } | null {
  if (e && typeof e === "object" && "body" in e) {
    const b = (e as { body?: unknown }).body;
    return b && typeof b === "object" ? (b as { code?: unknown; decision?: unknown }) : null;
  }
  return null;
}

/**
 * 预缓存后台失败（state==="failed"，快照带 errorCode）的中文短句；
 * 未知码给中性兜底，绝不透出上游细节。
 */
export function prefetchFailureMessage(code: string | null): string {
  if (code && UPDATE_ERROR_MESSAGES[code]) return UPDATE_ERROR_MESSAGES[code]!;
  return UPDATE_COPY.prefetchFailed;
}

/**
 * 预缓存进度百分比 [0,100]：
 *  - 总字节未知/非正 → null（面板不显示条，只显示已下载字节）；
 *  - 超限钳到 100，负值视为 0。
 */
export function prefetchPercent(received: number, size: number | null): number | null {
  if (!Number.isFinite(received) || received < 0) return null;
  if (size === null || !Number.isFinite(size) || size <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((received / size) * 100)));
}

/**
 * 归一「触发后台预下载」动作的错误为中文短句。
 * 与检查/换票错误共用映射表，额外处理两种 409：
 *  - body.decision==="busy"（已有别的预下载任务）→ 专用文案；
 *  - body.code==="UPDATE_NOT_AVAILABLE" 已在总表内。
 */
export function prefetchActionMessage(e: unknown): string {
  const body = bodyOf(e);
  if (body?.decision === "busy") return UPDATE_COPY.prefetchBusy;
  const code = typeof body?.code === "string" ? body.code : null;
  if (code && UPDATE_ERROR_MESSAGES[code]) return UPDATE_ERROR_MESSAGES[code]!;
  const status = statusOf(e);
  if (status === 403) return UPDATE_FORBIDDEN_MESSAGE;
  if (status === 408 || code === "UPDATE_SOURCE_TIMEOUT") return UPDATE_TIMEOUT_ERROR_MESSAGE;
  if (status === 0) return UPDATE_NETWORK_ERROR_MESSAGE;
  return UPDATE_FALLBACK_ERROR_MESSAGE;
}
