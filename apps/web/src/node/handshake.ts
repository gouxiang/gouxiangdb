// apps/web/src/node/handshake.ts
// 节点模式 S3（DESIGN §7）：对**显式指定的远端节点 baseURL** 做匿名探活/能力握手 + 账号登录。
//
// 与 api/client.ts 的关键区别：这些请求发生在"该节点成为当前活动数据源之前"，用户刚填完网址、
// 尚未连接，故**不能**走 dataSourceResolver（那指向当前活动源，可能是另一个节点或本地）。
// 所有 URL 都用传入的显式 baseURL 直连，鉴权头也不读本地会话。
//
// 边界：
//   - 纯逻辑、fetch 可注入（生产传 window.fetch，测试传 fake），不引新依赖、不被业务路径 import；
//   - fail-closed（DESIGN §7.3 / §6.10）：连不上、形态不符、版本不兼容、未初始化，一律给确定
//     错误码，绝不静默回落本机冒充远端；
//   - 复用现成端点，不要求远端新增字段：/api/health（探活+版本）、/api/auth/bootstrap-status
//     （是否已有管理员）；/api/v1/meta 仅在企业版挂载且需鉴权 → 匿名握手 404/401 属预期，
//     按"能力未知但版本兼容"放行（DESIGN §7.2 老节点前向兼容），不作为阻断项；
//   - 瘦客户端**不承接远端自举**：远端 initialized=false 时阻止登录（§7.3），避免在终端初始化别人的库。

import { withBase } from "../lib/base";
import type { UserDTO } from "@gx/shared-types";

/** 握手/登录失败的机器可读分类（UI 层据此映射 §7.3 确定文案）。 */
export type HandshakeErrorCode =
  | "unreachable" // DNS/连接拒绝/超时/CORS 被拒：根本连不上
  | "not_a_node" // 连上了但不是构想工作台节点（非 2xx / health 形态不符）
  | "version_incompatible" // major 不同或低于瘦客户端所测最低节点版本
  | "not_initialized" // 远端空库、尚无管理员：瘦客户端不承接远端自举
  | "bad_response"; // 响应体无法解析/形态不符

export class HandshakeError extends Error {
  constructor(
    public code: HandshakeErrorCode,
    /** 附加上下文（状态码/原始版本号），仅用于日志/调试，不直接展示。 */
    public detail?: string,
  ) {
    super(code);
    this.name = "HandshakeError";
  }
}

/** 登录失败分类（握手通过后的账号环节）。 */
export type LoginErrorCode =
  | "unreachable"
  | "invalid_credentials" // 401：邮箱或密码错误
  | "signup_closed" // 403 SIGNUP_CLOSED 等（登录一般不遇，预留）
  | "must_change_password" // 后端要求先改密（调用方按 user/tv 引导改密流程）
  | "error";

export class RemoteLoginError extends Error {
  constructor(
    public code: LoginErrorCode,
    public status: number,
    public body: { error?: string; code?: string; [k: string]: unknown },
  ) {
    super(code);
    this.name = "RemoteLoginError";
  }
}

/** 可注入的 fetch 形状（结构化最小集，便于单测；生产传 typeof fetch）。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HandshakeInput {
  /** 已规范化（normalizeNodeUrl.baseURL）或裸 origin 的远端 API 根，无尾斜杠。 */
  baseURL: string;
  fetchImpl?: FetchLike;
  /** 探活超时（DESIGN 建议 5s）；到点 abort，归为 unreachable。 */
  timeoutMs?: number;
  /**
   * 瘦客户端所测的最低兼容节点版本（semver-ish "major.minor.patch"）。
   * 规则（纯函数 isNodeVersionCompatible）：同 major 且 node >= minNode。
   */
  minNodeVersion?: string;
}

/** 握手成功后的节点画像（供 UI 展示产品名/版本/初始化态；meta 尽力而为可缺省）。 */
export interface NodeHandshake {
  /** /api/health 上报的节点版本。 */
  version: string;
  /** bootstrap-status.initialized：远端是否已有管理员。 */
  initialized: boolean;
  /** bootstrap-status.signupOpen。 */
  signupOpen: boolean;
  /** /api/v1/meta 能力位（企业版且匿名可达时才有；否则为 null，不阻断）。 */
  meta: Record<string, unknown> | null;
}

/** 解析 semver-ish "x.y.z"（容忍前导 v 与预发布后缀）为 [major,minor,patch]；非法返回 null。 */
export function parseSemver(input: string): [number, number, number] | null {
  if (typeof input !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(input.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * 版本兼容纯函数（DESIGN §7.2）：
 *   - 必须同 major（major 不同 = 协议代际不同 → 不兼容）；
 *   - 同 major 下 node >= minNode（逐 minor/patch 比较）；
 *   - 任一版本号无法解析 → false（fail-closed）。
 * minNodeVersion 缺省时只要求能解析出同 major 由调用方保证；这里无 min 视为仅校验 major>=0，
 * 即"只要 node 版本合法就放行"，具体门槛由握手入参注入。
 */
export function isNodeVersionCompatible(nodeVersion: string, minNodeVersion?: string): boolean {
  const node = parseSemver(nodeVersion);
  if (!node) return false;
  if (!minNodeVersion) return true;
  const min = parseSemver(minNodeVersion);
  if (!min) return false;
  if (node[0] !== min[0]) return false;
  if (node[1] !== min[1]) return node[1] > min[1];
  return node[2] >= min[2];
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 对远端节点执行只读握手：health（必需）→ bootstrap（必需）→ meta（尽力而为）。
 * 任一必需项失败即抛 HandshakeError；版本/初始化判定在此收口。
 */
export async function handshakeNode(input: HandshakeInput): Promise<NodeHandshake> {
  const fetchImpl = input.fetchImpl ?? defaultFetch();
  const timeoutMs = input.timeoutMs ?? 5_000;
  const base = input.baseURL;

  // 1) health：探活 + 版本。连不上（含 abort/网络错/CORS）→ unreachable。
  let healthRes: Response;
  try {
    healthRes = await fetchWithTimeout(fetchImpl, withBase(base, "/api/health"), timeoutMs);
  } catch {
    throw new HandshakeError("unreachable");
  }
  if (!healthRes.ok) throw new HandshakeError("not_a_node", `health ${healthRes.status}`);

  let healthJson: unknown;
  try {
    healthJson = await healthRes.json();
  } catch {
    throw new HandshakeError("bad_response", "health not json");
  }
  const version = (healthJson as { version?: unknown })?.version;
  if (typeof version !== "string" || !version) {
    throw new HandshakeError("not_a_node", "health missing version");
  }

  // 版本兼容（fail-closed）。
  if (!isNodeVersionCompatible(version, input.minNodeVersion)) {
    throw new HandshakeError("version_incompatible", version);
  }

  // 2) bootstrap-status：是否已有管理员。
  let bootRes: Response;
  try {
    bootRes = await fetchWithTimeout(
      fetchImpl,
      withBase(base, "/api/auth/bootstrap-status"),
      timeoutMs,
    );
  } catch {
    throw new HandshakeError("unreachable", "bootstrap");
  }
  if (!bootRes.ok) throw new HandshakeError("not_a_node", `bootstrap ${bootRes.status}`);
  let boot: { initialized?: unknown; signupOpen?: unknown };
  try {
    boot = (await bootRes.json()) as typeof boot;
  } catch {
    throw new HandshakeError("bad_response", "bootstrap not json");
  }
  if (typeof boot.initialized !== "boolean") {
    throw new HandshakeError("not_a_node", "bootstrap missing initialized");
  }
  // 瘦客户端不承接远端自举：远端空库 → 阻止登录。
  if (!boot.initialized) throw new HandshakeError("not_initialized");

  // 3) meta：企业版且匿名可达才存在；404/401/连不上都按"能力未知"放行（不阻断登录）。
  let meta: Record<string, unknown> | null = null;
  try {
    const metaRes = await fetchWithTimeout(
      fetchImpl,
      withBase(base, "/api/v1/meta"),
      timeoutMs,
    );
    if (metaRes.ok) meta = (await metaRes.json()) as Record<string, unknown>;
  } catch {
    meta = null;
  }

  return {
    version,
    initialized: boot.initialized,
    signupOpen: boot.signupOpen === true,
    meta,
  };
}

export interface RemoteLoginInput {
  baseURL: string;
  email: string;
  password: string;
  fetchImpl?: FetchLike;
  /** 登录超时（DESIGN 建议 10s）。 */
  timeoutMs?: number;
}

export interface RemoteLoginResult {
  token: string;
  user: UserDTO;
}

function defaultFetch(): FetchLike {
  if (typeof fetch !== "function") {
    throw new Error("当前环境没有可用的 fetch，请注入 fetchImpl");
  }
  return fetch as FetchLike;
}

/**
 * 向远端节点换取远端 JWT（DESIGN §8.1）：POST {base}/api/auth/login。
 * 成功返回 { token, user }；401 → invalid_credentials；网络层错误 → unreachable。
 * 注意：本函数只换取凭据，**不**写本地/远端会话、**不**切换数据源——由启动器编排层负责。
 */
export async function loginRemoteNode(
  input: RemoteLoginInput,
): Promise<RemoteLoginResult> {
  const fetchImpl = input.fetchImpl ?? defaultFetch();
  const timeoutMs = input.timeoutMs ?? 10_000;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      withBase(input.baseURL, "/api/auth/login"),
      timeoutMs,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: input.email, password: input.password }),
      },
    );
  } catch {
    throw new RemoteLoginError("unreachable", 0, {});
  }

  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    token?: string;
    user?: UserDTO;
  };

  if (!res.ok) {
    let code: LoginErrorCode = "error";
    if (res.status === 401) code = "invalid_credentials";
    else if (res.status === 403 && body.code === "SIGNUP_CLOSED") code = "signup_closed";
    throw new RemoteLoginError(code, res.status, body);
  }
  if (typeof body.token !== "string" || !body.token || !body.user) {
    throw new RemoteLoginError("error", res.status, body as Record<string, unknown>);
  }
  return { token: body.token, user: body.user };
}
