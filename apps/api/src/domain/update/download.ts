// apps/api/src/domain/update/download.ts
// 应用更新下载票据（DESIGN §6.2）：浏览器原生文件下载（<a>/window.location）带不了
// Authorization/X-GX-Token 头，故 owner 先经登录态换一张短 TTL 的无状态 HMAC 票，
// 再凭票走 ?ticket= 发起原生导航下载。
//
// 设计纪律（逐字落地 §6.2）：
//   - 无状态：不引第三方依赖、不落库、不建表，只用 node:crypto + 既有 JWT_SECRET；
//   - 无服务端单次核销（无状态做不到）；防滥用靠：短 TTL（120s）+ owner 绑定 +
//     下载端点自身审计 + 全局限流；票据不对应任何可改写资源；
//   - 票据串 = base64url(JSON payload) + "." + base64url(HMAC-SHA256)，恒长时校验防篡改；
//   - 独立密钥域（与登录 JWT 区分），避免同一 secret 下两类 token 跨用途混用；
//   - 校验做字段白名单 + 类型 + filename 字符白名单，拒绝任何多余/畸形字段；
//   - 本模块是纯函数（secret/now 注入），不读 env、不碰 Hono/db，可表驱动单测。

import { createHmac, timingSafeEqual } from "node:crypto";

/** 下载票据载荷（字段顺序即白名单，verify 时逐字段类型校验）。 */
export interface DownloadTicketPayload {
  /** 换票的 owner 用户 id（下载审计 actorId；票据与该 owner 绑定）。 */
  uid: string;
  /** 通道 id（注册表内 id，如 fnos-fpk）。 */
  channel: string;
  /** 统一架构词汇 x64 / arm64。 */
  arch: string;
  /** Node 平台词汇 linux / darwin / win32。 */
  platform: string;
  /** 命中的候选发布版本（定位 release 用）。 */
  version: string;
  /** 经清单白名单校验的资产文件名（Content-Disposition 用，禁止用户自由拼接）。 */
  filename: string;
  /** 绝对过期时间（epoch 毫秒）。 */
  exp: number;
}

/** 独立密钥域前缀：让更新票据的签名与登录 JWT/其它 HMAC 不可互替。 */
const KEY_DOMAIN = "gouxiangdb-update-download-ticket/v1:";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function mac(secret: string, payloadB64: string): string {
  return createHmac("sha256", KEY_DOMAIN + secret)
    .update(payloadB64)
    .digest("base64url");
}

/** 常量时间字符串比较（长度不同直接 false，不抛异常）。 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * filename 白名单（§6.2 第 3 条）：只允许文件名字符，绝不允许路径/分隔/控制符/空白/非 ASCII。
 * 形态：1-120 字符，字母数字与 ._- 组成，必须含扩展名，不以点开头，不含连续点穿越。
 */
export function isSafeArtifactFilename(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 120) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  if (name.startsWith(".") || name.includes("..")) return false;
  return /\.[A-Za-z0-9]+$/.test(name);
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ARCHES = new Set(["x64", "arm64"]);
const PLATFORMS = new Set(["linux", "darwin", "win32"]);

/** 校验载荷字段形状（白名单：键集合、类型、取值域、filename 字符）。合法返回 true。 */
export function isWellFormedPayload(v: unknown): v is DownloadTicketPayload {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  const allowed = new Set(["uid", "channel", "arch", "platform", "version", "filename", "exp"]);
  const keys = Object.keys(p);
  if (keys.length !== allowed.size) return false;
  if (!keys.every((k) => allowed.has(k))) return false;
  if (typeof p.uid !== "string" || !ID_RE.test(p.uid)) return false;
  if (typeof p.channel !== "string" || !ID_RE.test(p.channel)) return false;
  if (typeof p.arch !== "string" || !ARCHES.has(p.arch)) return false;
  if (typeof p.platform !== "string" || !PLATFORMS.has(p.platform)) return false;
  if (typeof p.version !== "string" || !ID_RE.test(p.version.replace(/\./g, "-"))) return false;
  if (!isSafeArtifactFilename(p.filename)) return false;
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp) || p.exp <= 0) return false;
  return true;
}

export interface IssueTicketArgs {
  secret: string;
  uid: string;
  channel: string;
  arch: string;
  platform: string;
  version: string;
  filename: string;
  ttlMs: number;
  /** 注入时钟（测试），默认 Date.now。 */
  now?: number;
}

/** 签发一张票据；调用方应已现场确认「有更新且 eligible 且 artifact 存在」。 */
export function issueDownloadTicket(args: IssueTicketArgs): {
  ticket: string;
  expiresAt: number;
} {
  const now = args.now ?? Date.now();
  const payload: DownloadTicketPayload = {
    uid: args.uid,
    channel: args.channel,
    arch: args.arch,
    platform: args.platform,
    version: args.version,
    filename: args.filename,
    exp: now + args.ttlMs,
  };
  if (!isWellFormedPayload(payload)) {
    // 组装期就畸形 = 接线 bug（filename 应来自净化后的清单），直接 fail-closed。
    throw new Error("下载票据载荷非法");
  }
  const payloadB64 = b64url(JSON.stringify(payload));
  return { ticket: `${payloadB64}.${mac(args.secret, payloadB64)}`, expiresAt: payload.exp };
}

/**
 * 校验票据：签名不符/格式坏/载荷畸形/已过期一律返回 null（调用方映射 401
 * UPDATE_TICKET_INVALID）。now 注入供过期测试。
 */
export function verifyDownloadTicket(
  secret: string,
  ticket: string,
  now: number = Date.now(),
): DownloadTicketPayload | null {
  if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > 4096) return null;
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot === ticket.length - 1) return null;
  // 只允许一个分隔点（base64url 字母表不含 "."）。
  if (ticket.indexOf(".", dot + 1) !== -1) return null;
  const payloadB64 = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;

  // 先验签名（常量时间），再解码：伪造票拿不到任何内容分支。
  if (!safeEqual(sig, mac(secret, payloadB64))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isWellFormedPayload(parsed)) return null;
  if (now >= parsed.exp) return null;
  return parsed;
}
