// apps/api/src/audit/__tests__/audit.test.ts
// 审计：脱敏、字段齐全、JSONL 每行可解析、真实落盘文件无 password/token/bearer 明文。

import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatAuditEvent,
  redactSecrets,
  serializeAuditRecord,
  writeAudit,
} from "../audit.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-audit-"));
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("redactSecrets", () => {
  it("递归脱敏敏感键，保留普通字段", () => {
    const out = redactSecrets({
      email: "a@b.co",
      password: "hunter2",
      nested: { token: "abc.def", ok: 1, Authorization: "Bearer xyz" },
      list: [{ jwt: "s", q: 1 }],
    }) as Record<string, unknown>;
    expect(out.email).toBe("a@b.co");
    expect(out.password).toBe("[REDACTED]");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.token).toBe("[REDACTED]");
    expect(nested.Authorization).toBe("[REDACTED]");
    expect(nested.ok).toBe(1);
    const list = out.list as Array<Record<string, unknown>>;
    expect(list[0]!.jwt).toBe("[REDACTED]");
    expect(list[0]!.q).toBe(1);
  });

  it("键名大小写与含子串均可命中", () => {
    const out = redactSecrets({
      PASSWORD: "x",
      accessToken: "y",
      client_secret: "z",
    }) as Record<string, string>;
    expect(out.PASSWORD).toBe("[REDACTED]");
    expect(out.accessToken).toBe("[REDACTED]");
    expect(out.client_secret).toBe("[REDACTED]");
  });
});

describe("formatAuditEvent / serialize", () => {
  it("字段齐全且 ISO 时间，detail 已脱敏", () => {
    const rec = formatAuditEvent({
      event: "login_failure",
      ip: "203.0.113.7",
      method: "post",
      path: "/api/auth/login",
      status: 401,
      detail: { reason: "bad_password", password: "p" },
    });
    expect(rec.event).toBe("login_failure");
    expect(rec.actorId).toBeNull();
    expect(rec.method).toBe("POST");
    expect(rec.ip).toBe("203.0.113.7");
    expect(rec.status).toBe(401);
    expect(Number.isNaN(Date.parse(rec.ts))).toBe(false);
    expect(rec.detail.password).toBe("[REDACTED]");
    expect(serializeAuditRecord(rec).split("\n")).toHaveLength(1);
  });
});

describe("writeAudit JSONL 落盘", () => {
  it("追加两行，每行都是合法 JSON 且无密钥明文", () => {
    writeAudit(tmpDir, {
      event: "login_success",
      actorId: "u1",
      ip: "10.0.0.5",
      method: "POST",
      path: "/api/auth/login",
      status: 200,
    });
    writeAudit(tmpDir, {
      event: "change_password",
      actorId: "u2",
      ip: "10.0.0.6",
      method: "POST",
      path: "/api/auth/me/change-password",
      status: 200,
      detail: { newPassword: "secret-123", bearer: "b" },
    });

    const file = path.join(tmpDir, "audit.logl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed[0]!.event).toBe("login_success");
    expect(parsed[1]!.event).toBe("change_password");
    // 敏感键的值必须被脱敏
    const detail = parsed[1]!.detail as Record<string, string>;
    expect(detail.newPassword).toBe("[REDACTED]");
    expect(detail.bearer).toBe("[REDACTED]");

    // 原始文件中绝不出现任何敏感明文值
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("secret-123");
    expect(raw).not.toContain("Bearer xyz");
    expect(raw.toLowerCase()).not.toMatch(/password"\s*:\s*"(?!\[redacted\])/);
  });

  it("sink 抛错时不向调用方抛出（审计不阻断业务）", () => {
    expect(() =>
      writeAudit("/nonexistent-root/xyz", {
        event: "login_success",
        status: 200,
      }, () => {
        throw new Error("disk full");
      }),
    ).not.toThrow();
  });
});
