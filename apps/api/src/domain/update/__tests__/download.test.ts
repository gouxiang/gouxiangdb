// 下载票据（domain/update/download.ts）纯函数单测：签发/校验、过期、伪造/篡改、
// 字段白名单、filename 字符白名单。无 Hono/db/网络，全部表驱动。

import { describe, expect, it } from "vitest";
import {
  isSafeArtifactFilename,
  isWellFormedPayload,
  issueDownloadTicket,
  verifyDownloadTicket,
  type DownloadTicketPayload,
} from "../download.js";

const SECRET = "test-jwt-secret-at-least-16-chars";
const TTL = 120_000;
const NOW = 1_700_000_000_000;

const baseArgs = {
  secret: SECRET,
  uid: "user-owner",
  channel: "fnos-fpk",
  arch: "x64",
  platform: "linux",
  version: "0.2.3",
  filename: "gouxiangdb-0.2.3-x86.fpk",
  ttlMs: TTL,
};

function validPayload(over: Partial<DownloadTicketPayload> = {}): DownloadTicketPayload {
  return {
    uid: "user-owner",
    channel: "fnos-fpk",
    arch: "x64",
    platform: "linux",
    version: "0.2.3",
    filename: "gouxiangdb-0.2.3-x86.fpk",
    exp: NOW + TTL,
    ...over,
  };
}

describe("issue + verify 往返", () => {
  it("合法票据可解出原载荷", () => {
    const { ticket, expiresAt } = issueDownloadTicket({ ...baseArgs, now: NOW });
    expect(expiresAt).toBe(NOW + TTL);
    const p = verifyDownloadTicket(SECRET, ticket, NOW + 1000);
    expect(p).not.toBeNull();
    expect(p).toMatchObject({
      uid: "user-owner", channel: "fnos-fpk", arch: "x64",
      platform: "linux", version: "0.2.3", filename: "gouxiangdb-0.2.3-x86.fpk",
    });
  });

  it("exp 边界：now<exp 有效；now>=exp 失效", () => {
    const { ticket, expiresAt } = issueDownloadTicket({ ...baseArgs, now: NOW });
    expect(verifyDownloadTicket(SECRET, ticket, expiresAt - 1)).not.toBeNull();
    expect(verifyDownloadTicket(SECRET, ticket, expiresAt)).toBeNull();
  });

  it("用另一 secret 验签失败", () => {
    const { ticket } = issueDownloadTicket(baseArgs);
    expect(verifyDownloadTicket("another-secret-xxxxxxxxxxxx", ticket)).toBeNull();
  });
});

describe("伪造/篡改", () => {
  it("完全随机字符串 -> null", () => {
    expect(verifyDownloadTicket(SECRET, "not-a-ticket")).toBeNull();
    expect(verifyDownloadTicket(SECRET, "")).toBeNull();
    expect(verifyDownloadTicket(SECRET, "a.b.c")).toBeNull(); // 多一个点
    expect(verifyDownloadTicket(SECRET, ".sig")).toBeNull();
    expect(verifyDownloadTicket(SECRET, "payload.")).toBeNull();
    expect(verifyDownloadTicket(SECRET, "pay load.sig")).toBeNull(); // 非 base64url 空白
  });

  it("篡改 payload 段（改版本）签名失效", () => {
    const { ticket } = issueDownloadTicket(baseArgs);
    const [p, sig] = ticket.split(".");
    const obj = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    obj.version = "9.9.9";
    const forged = `${Buffer.from(JSON.stringify(obj)).toString("base64url")}.${sig}`;
    expect(verifyDownloadTicket(SECRET, forged)).toBeNull();
  });

  it("伪造签名段", () => {
    const { ticket } = issueDownloadTicket(baseArgs);
    const [p] = ticket.split(".");
    expect(verifyDownloadTicket(SECRET, `${p}.${"a".repeat(43)}`)).toBeNull();
  });

  it("换票绑他人：仅改 uid 也会破坏签名", () => {
    const { ticket } = issueDownloadTicket(baseArgs);
    const [p, sig] = ticket.split(".");
    const obj = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    obj.uid = "user-victim";
    const forged = `${Buffer.from(JSON.stringify(obj)).toString("base64url")}.${sig}`;
    expect(verifyDownloadTicket(SECRET, forged)).toBeNull();
  });

  it("超长票据直接拒（不解析）", () => {
    expect(verifyDownloadTicket(SECRET, `${"a".repeat(5000)}.sig`)).toBeNull();
  });
});

describe("payload 字段白名单", () => {
  it("多余字段 -> 非法", () => {
    expect(isWellFormedPayload(validPayload({ exp: NOW + TTL }))).toBe(true);
    expect(isWellFormedPayload({ ...validPayload(), admin: true })).toBe(false);
    expect(isWellFormedPayload({ ...validPayload(), url: "http://x" })).toBe(false);
  });

  it("缺字段 -> 非法", () => {
    const p = validPayload();
    for (const k of Object.keys(p)) {
      const cp = { ...p };
      delete (cp as Record<string, unknown>)[k];
      expect(isWellFormedPayload(cp), `缺 ${k}`).toBe(false);
    }
  });

  it("类型错误 -> 非法", () => {
    expect(isWellFormedPayload(validPayload({ uid: 123 as unknown as string }))).toBe(false);
    expect(isWellFormedPayload(validPayload({ arch: "armv7" }))).toBe(false);
    expect(isWellFormedPayload(validPayload({ platform: "freebsd" }))).toBe(false);
    expect(isWellFormedPayload(validPayload({ channel: "bad channel!" }))).toBe(false);
    expect(isWellFormedPayload(validPayload({ exp: "later" as unknown as number }))).toBe(false);
    expect(isWellFormedPayload(validPayload({ exp: -1 }))).toBe(false);
    expect(isWellFormedPayload("nope")).toBe(false);
    expect(isWellFormedPayload(null)).toBe(false);
    expect(isWellFormedPayload([])).toBe(false);
  });

  it("arm64 / 各平台合法", () => {
    expect(isWellFormedPayload(validPayload({ arch: "arm64" }))).toBe(true);
    for (const platform of ["darwin", "win32"] as const) {
      expect(isWellFormedPayload(validPayload({ platform }))).toBe(true);
    }
  });
});

describe("filename 白名单", () => {
  const ok = ["a.fpk", "gouxiangdb-0.2.3-x86.fpk", "GOUXIANG_0.2.3-x64.tar.gz", "x.y"];
  const bad = [
    "../etc/passwd.fpk",
    "a/b.fpk",
    "a\\b.fpk",
    "..evil.fpk", // 前导穿越
    "noext",
    ".hidden",
    "a fp k.fpk",
    "a.fpk\n",
    "中文包.fpk",
    "a$.fpk",
    "",
    "a".repeat(122) + ".fpk", // 超 120
  ];

  it("合法名通过", () => {
    for (const n of ok) expect(isSafeArtifactFilename(n), n).toBe(true);
  });
  it("非法名拒绝", () => {
    for (const n of bad) expect(isSafeArtifactFilename(n), JSON.stringify(n)).toBe(false);
  });
  it("非法 filename 签发即抛", () => {
    expect(() => issueDownloadTicket({ ...baseArgs, filename: "../x.fpk" })).toThrow();
  });
});
