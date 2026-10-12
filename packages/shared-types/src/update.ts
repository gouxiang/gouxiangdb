// packages/shared-types/src/update.ts
// 应用更新机制：前后端共用的版本比较纯函数 + 清单 / DTO 类型真源。
//
// 设计唯一依据：docs/design/2026-10-app-update/DESIGN.md §4（版本比较规则）、§5（数据结构）。
// 本文件【不读 env、不读文件、不引第三方依赖】：
//   - 比较逻辑放 shared（api esbuild 内化源码、web vite 直接吃 TS、发布脚本可复用）；
//   - 当前「版本值」的来源（GX_VERSION / 根 package.json / 兜底）仍在 apps/api/src/version.ts，
//     禁止在 shared 另起版本读取。

// ---------------------------------------------------------------------------
// 通道
// ---------------------------------------------------------------------------

export type KnownChannelId = "fnos-fpk" | "source-bare" | "desktop-client";

/** 通道 id 允许未来扩展：注册表外的 id 一律按 unknown 处理。 */
export type ChannelId = KnownChannelId | (string & {});

// ---------------------------------------------------------------------------
// 版本解析与比较（DESIGN §4.1，11 条规则）
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** 预发布标识符段，如 ["rc",1]；正式版为 []。 */
  prerelease: ReadonlyArray<string | number>;
  /** 原始入参字符串（排障展示用）。 */
  raw: string;
  /** "0.0.0-dev" 这类兜底值 / 非法值解析失败。 */
  valid: boolean;
}

/** 预发布标识符：纯数字段收为 number，其余保持 string。 */
type PrereleaseId = string | number;

// 数字段拒绝前导 0（semver 2.0：0 或 [1-9] 开头）；预发布段允许 0[1-9] 这类非数字/字母混合标识。
const NUM = "(?:0|[1-9]\\d*)";
const VERSION_RE = new RegExp(
  `^v?(${NUM})\\.(${NUM})\\.(${NUM})(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

function invalidVersion(raw: string): ParsedVersion {
  return { major: 0, minor: 0, patch: 0, prerelease: [], raw, valid: false };
}

/**
 * 宽松解析：剥离可选前导 v 与构建元数据（+build）；非法返回 { valid:false, raw }，不抛异常。
 *
 * 特别地：核心版本为 `0.0.0` 且带预发布后缀（如兜底常量 "0.0.0-dev"）判为 invalid —— 这是
 * 「版本未知」的哨兵，而不是一个可发布版本（DESIGN §4.1 规则 6）。注意纯 "0.0.0" 仍合法，
 * 因为 minVersion 缺省值就是 "0.0.0"（DESIGN §5.1），必须能参与比较。
 */
export function parseVersion(input: unknown): ParsedVersion {
  if (typeof input !== "string") return invalidVersion(String(input ?? ""));
  const raw = input.trim();
  const m = VERSION_RE.exec(raw);
  if (!m) return invalidVersion(raw);
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const prerelease: PrereleaseId[] = m[4]
    ? m[4].split(".").map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg))
    : [];
  // 0.0.0-* ＝开发/兜底哨兵，不参与更新决策。
  if (major === 0 && minor === 0 && patch === 0 && prerelease.length > 0) {
    return invalidVersion(raw);
  }
  return { major, minor, patch, prerelease, raw, valid: true };
}

/** 比较两个预发布标识符数组（semver 经典规则）。仅在核心 x.y.z 相等时调用。 */
function comparePrerelease(a: ReadonlyArray<PrereleaseId>, b: ReadonlyArray<PrereleaseId>): -1 | 0 | 1 {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === undefined && y !== undefined) return -1; // 公共前缀相同，段数少的更小
    if (x !== undefined && y === undefined) return 1;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && !yNum) return -1; // 数字段 < 非数字段
    if (!xNum && yNum) return 1;
    if (xNum && yNum) {
      if ((x as number) < (y as number)) return -1;
      if ((x as number) > (y as number)) return 1;
    } else {
      const xs = String(x);
      const ys = String(y);
      if (xs < ys) return -1;
      if (xs > ys) return 1;
    }
  }
  return 0;
}

/**
 * 比较两个版本字符串。
 * @returns `-1` a<b，`0` 相等，`1` a>b；任一版本不可解析返回 `null`（调用方按 §4.1 处理）。
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa.valid || !pb.valid) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  // 核心相同：带预发布后缀 < 不带后缀（0.2.3-rc1 < 0.2.3）。
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length > 0 && pb.prerelease.length === 0) return -1;
  if (pa.prerelease.length === 0 && pb.prerelease.length > 0) return 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

export type UpdateVerdict = "latest" | "upgrade" | "downgrade" | "incomparable";

export interface DecideUpdateArgs {
  currentVersion: string;
  candidateVersion: string;
  /** 是否纳入预发布候选（GX_UPDATE_ALLOW_PRERELEASE=on 精确小写时为 true）。 */
  allowPrerelease: boolean;
  /** 清单中该 release 的 prerelease 声明（权威来源）。 */
  candidatePrerelease: boolean;
}

/**
 * 给定当前版本与候选 release，返回提示决策（表驱动友好）。
 *
 * - 当前或候选版本不可解析（含 0.0.0-dev 兜底）→ "incomparable"（不提示，fail-safe）。
 * - 候选为预发布且未放行 → "latest"（不提示；默认不纳入候选）。
 * - 相等 → "latest"；候选更低 → "downgrade"（不提示）；候选更高 → "upgrade"。
 *
 * belowMin 不在这里吞掉：调用方另用 compareVersions(current, minVersion) 计算并透传展示。
 */
export function decideUpdate(args: DecideUpdateArgs): UpdateVerdict {
  const { currentVersion, candidateVersion, allowPrerelease, candidatePrerelease } = args;
  const current = parseVersion(currentVersion);
  const candidate = parseVersion(candidateVersion);
  if (!current.valid || !candidate.valid) return "incomparable";
  if (candidatePrerelease && !allowPrerelease) return "latest";
  const cmp = compareVersions(currentVersion, candidateVersion);
  if (cmp === null) return "incomparable";
  if (cmp === 0) return "latest";
  return cmp < 0 ? "upgrade" : "downgrade";
}

// ---------------------------------------------------------------------------
// 更新清单（DESIGN §5.1 UpdateManifest JSON）
// ---------------------------------------------------------------------------

export type ArtifactArch = "x64" | "arm64" | "any";
export type ArtifactPlatform = "linux" | "darwin" | "win32" | "any";

export interface ArtifactManifest {
  arch: ArtifactArch;
  platform: ArtifactPlatform;
  filename: string;
  sizeBytes: number;
  sha256: string;
  download:
    | { kind: "release-asset"; asset: string }
    | { kind: "url"; url: string };
  signature: { alg: "minisign" | "gpg"; value: string } | null;
}

export interface ReleaseNotes {
  format: "markdown" | "text";
  zh: string;
  en: string | null;
}

export interface ReleaseManifest {
  version: string;
  publishedAt: string;
  prerelease: boolean;
  minVersion: string | null;
  releaseNotes: ReleaseNotes;
  artifacts: ArtifactManifest[];
}

export interface ChannelManifest {
  releases: ReleaseManifest[];
}

export interface UpdateManifest {
  schemaVersion: 1;
  product: "gouxiangdb";
  generatedAt: string;
  channels: Partial<Record<ChannelId, ChannelManifest>>;
}

// ---------------------------------------------------------------------------
// HTTP DTO（GET /api/v1/admin/update/status 响应，DESIGN §5.2）
// ---------------------------------------------------------------------------

export interface CurrentIdentityDTO {
  version: string;
  versionUnparseable: boolean;
  channel: ChannelId | "unknown";
  arch: string;
  platform: string;
}

export type InstallGuideKind = "fnos-upload" | "bash-deploy" | "desktop-installer";

export interface ManualInstallGuideDTO {
  kind: InstallGuideKind;
  /** 有序步骤，前端按 ol 渲染，不允许嵌入 HTML。 */
  steps: string[];
  /** 升级前提示（备份/数据保留口径），单独一块展示。 */
  preUpgradeNote: string;
}

export interface UpdateInfoArtifactDTO {
  arch: string;
  platform: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
}

export interface UpdateInfoDTO {
  version: string;
  publishedAt: string;
  releaseNotes: { format: "markdown" | "text"; zh: string };
  minVersion: string | null;
  /** false = 低于 minVersion，只告知联系支持，不提供下载。 */
  eligible: boolean;
  ineligibleReason: "below_min_version" | null;
  /** eligible=false 时 artifact 为 null。 */
  artifact: UpdateInfoArtifactDTO | null;
  manualInstallGuide: ManualInstallGuideDTO;
}

// ---------------------------------------------------------------------------
// 后台预缓存快照（方案 A：NAS 本地后台预取更新包，面板点下载时本地秒取）
//
// 背景：飞牛 CGI 反代对单次请求硬限 ~30s 且整包缓冲，公网慢时面板内直连下载 63MB 必 502。
// 改为 owner 触发后端在后台分块把包预拉到 NAS 本地，就绪后浏览器凭原下载票从本地秒取。
// 本快照只暴露进度与稳定状态，【不含】任何 url / token / 上游错误体。
// ---------------------------------------------------------------------------

/**
 * 预缓存状态机：
 *  - idle    从未对任何目标开始过（无 .part / 无成品）；
 *  - running 正在后台分块拉取（receivedBytes/sizeBytes 为进度）；
 *  - ready   已拉完并通过 sha256 校验，download 端点可本地命中秒取；
 *  - failed  最近一次尝试失败（保留 .part，可续传重试），带稳定 errorCode。
 */
export type UpdatePrefetchState = "idle" | "running" | "ready" | "failed";

export interface UpdatePrefetchDTO {
  state: UpdatePrefetchState;
  /**
   * 内容寻址键（= 资产 sha256）。前端据此与 update.artifact.sha256 对齐，
   * 判断「就绪包是不是当前候选版本」；idle 时为 null。
   */
  sha256: string | null;
  /** 预缓存目标版本；idle 时为 null。 */
  version: string | null;
  /** 预缓存目标文件名（仅安全字符，同下载票口径）；idle 时为 null。 */
  filename: string | null;
  /** 清单声明的包总字节；未知时为 null。 */
  sizeBytes: number | null;
  /** 已落盘字节（含可续传的 .part 部分）；idle/未开始为 0。 */
  receivedBytes: number;
  /** state==="failed" 时的稳定错误码（中性、可展示），其余状态为 null。 */
  errorCode: UpdatePrefetchErrorCode | null;
  /** 最近一次状态变更时间（ISO 字符串）；从未开始为 null。 */
  updatedAt: string | null;
}

/**
 * 预缓存稳定错误码（收敛上游细节，绝不透传上游错误体）：
 *  - PREFETCH_AUTH            上游凭证无效/过期；
 *  - PREFETCH_UNREACHABLE     上游不可达 / HTTP 非 2xx-206；
 *  - PREFETCH_TIMEOUT         拉取空闲超时（.part 保留，可续传）；
 *  - PREFETCH_CHECKSUM        落盘后 sha256 校验不符（成品不落地）；
 *  - PREFETCH_DISK            磁盘空间/写入失败；
 *  - PREFETCH_BAD_STATE       本地缓存目录状态异常（无法安全续传）。
 */
export type UpdatePrefetchErrorCode =
  | "PREFETCH_AUTH"
  | "PREFETCH_UNREACHABLE"
  | "PREFETCH_TIMEOUT"
  | "PREFETCH_CHECKSUM"
  | "PREFETCH_DISK"
  | "PREFETCH_BAD_STATE";

export interface UpdateStatusDTO {
  enabled: true;
  current: CurrentIdentityDTO;
  update: UpdateInfoDTO | null;
  checkedAt: string;
  /** 清单 schemaVersion 高于本端认识值时 true（面板弱提示，不报错）。 */
  newerSchema: boolean;
  /**
   * 后台预缓存快照（方案 A）。可选：旧端/未接入该机制时缺省；新版 status 路由恒带此字段。
   * 前端据 prefetch.sha256 与 update.artifact.sha256 判定就绪包是否对应当前候选。
   */
  prefetch?: UpdatePrefetchDTO | null;
}

export interface UpdateDisabledDTO {
  enabled: false;
  current: CurrentIdentityDTO;
}
