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
