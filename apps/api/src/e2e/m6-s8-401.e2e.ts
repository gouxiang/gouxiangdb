// M6/S8-D 401 五态 + 认证失败审计。
//
// 五态：无 token / 伪造 token / 过期 / 已吊销 / 主体停用。
// 口径（派工单 §D + 计划 §4.3 的既有定稿）：五态一律 HTTP 401 + JSON-RPC -32001 id:null；
//   "查不到"三态（无 Bearer / 无前缀 / 未知 token）**响应体逐字节一致**（不可区分，防枚举）；
//   吊销/过期/停用**各自可辨识**——这是计划 §4.3 明文设计（"revoked/expired/disabled 各自可辨识"），
//   与派工单"五态响应体不区分"的措辞**存在口径差异**，本文件如实把两者都钉住并在报告中提出。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapE2e, type E2eStack } from "./bootstrap.js";
import { INIT_MESSAGE, rpc } from "./serverHarness.js";
import { auditOf, readAudit } from "./clientHarness.js";
import { dumpAttackMatrix, recordAttack } from "./attackLog.js";

let stack: E2eStack;
const t = { forged: `gxpat_${"Z".repeat(32)}`, noPrefix: "not-a-pat-token", expired: "", revoked: "", disabled: "" };
/** 无 token 的用例名与 thunk（数组在 collect 期求值，故延迟取值）。 */
const STATES: Array<{ label: string; reason: string; pick: () => string | undefined }> = [
  { label: "无 token", reason: "missing_bearer", pick: () => undefined },
  { label: "伪造 token（gxpat_ 前缀但查不到）", reason: "unknown_token", pick: () => t.forged },
  { label: "非 PAT 形态（无 gxpat_ 前缀）", reason: "not_pat_prefix", pick: () => t.noPrefix },
  { label: "过期 token", reason: "expired", pick: () => t.expired },
  { label: "已吊销 token", reason: "revoked", pick: () => t.revoked },
  { label: "主体停用", reason: "account_disabled", pick: () => t.disabled },
];

interface AuthBody { jsonrpc: string; id: unknown; error: { code: number; message: string } }

async function probe(token: string | undefined): Promise<{ status: number; body: AuthBody; raw: string; wwwAuth: string | null }> {
  const res = await rpc(stack.tcp.target, INIT_MESSAGE, token ? { token } : {});
  const raw = await res.text();
  return { status: res.status, body: JSON.parse(raw) as AuthBody, raw, wwwAuth: res.headers.get("www-authenticate") };
}

beforeAll(async () => {
  stack = await bootstrapE2e("gx-m6-s8-401-");
  const svc = await import("../mcp/pat/patService.js");
  const mk = async (userId: string, name: string): Promise<{ id: string; token: string }> => {
    const r = await svc.createPat(userId, { name, scopes: ["record:read"], expiresInDays: 90 });
    return { id: r.pat.id, token: r.plaintext };
  };
  const exp = await mk("uFull", "expired");
  await stack.prisma.personalAccessToken.update({ where: { id: exp.id }, data: { expiresAt: new Date("2020-01-01T00:00:00Z") } });
  t.expired = exp.token;
  const rev = await mk("uFull", "revoked");
  await svc.revokePat("uFull", rev.id);
  t.revoked = rev.token;
  t.disabled = (await mk("uOther", "disabled")).token;
  await stack.prisma.user.update({ where: { id: "uOther" }, data: { status: "DISABLED" } });
}, 240_000);

afterAll(async () => {
  dumpAttackMatrix();
  await stack?.close();
});

describe("S8-D 五态 401（HTTP 层 + JSON-RPC 信封 + WWW-Authenticate）", () => {
  for (const s of STATES) {
    it(`${s.label} -> 401 / -32001 / id:null`, async () => {
      const r = await probe(s.pick());
      expect(r.status, s.label).toBe(401);
      expect(r.wwwAuth ?? "", s.label).toContain("Bearer");
      expect(Object.keys(r.body).sort(), s.label).toEqual(["error", "id", "jsonrpc"]);
      expect(r.body.jsonrpc, s.label).toBe("2.0");
      expect(r.body.id, s.label).toBeNull();
      expect(r.body.error.code, s.label).toBe(-32001);
      recordAttack({ id: `401/${s.reason}`, entry: "http", input: `initialize with ${s.label}`, expected: "HTTP 401 + -32001 id:null", actual: `401 / ${r.body.error.message}`, verdict: "PASS" });
    });
  }

  it("「查不到」三态（无 Bearer / 非前缀 / 未知 token）响应体逐字节一致 —— 不泄漏 token 是否存在", async () => {
    const missing = await probe(undefined);
    const noPrefix = await probe(t.noPrefix);
    const unknown = await probe(t.forged);
    expect(noPrefix.raw).toBe(missing.raw);
    expect(unknown.raw).toBe(missing.raw);
    expect(missing.body.error.message).toBe("Unauthorized");
  });

  it("吊销/过期/停用三态可辨识 —— 与派工单措辞不同（计划 §4.3 明文设计），如实登记", async () => {
    const expired = await probe(t.expired);
    const revoked = await probe(t.revoked);
    const disabled = await probe(t.disabled);
    const msgs = [expired.body.error.message, revoked.body.error.message, disabled.body.error.message];
    expect(new Set(msgs).size).toBe(3); // 三者互不相同（= 可辨识）
    expect(msgs).toEqual(["Token expired", "Token revoked", "Account disabled"]);
    // 如实播报口径差异，供出口复核者裁决（不擅自改生产码）
    console.warn(
      `[M6-S8][口径差异] 401 五态并非全部"响应体不区分"：吊销/过期/停用三态文案分别为 ${msgs.join(" / ")}`
      + "（计划 §4.3 明文设计为可辨识；派工单 §D 写的是「响应体不区分」）。已按现状钉住，未改生产码。",
    );
    recordAttack({ id: "401/口径差异", entry: "http", input: "expired / revoked / disabled 三态对拍", expected: "派工单：响应体不区分", actual: `现状：可辨识（${msgs.join(" / ")}）`, verdict: "PASS", note: "计划 §4.3 明文的可辨识设计；差异待裁决" });
  });
});

describe("S8-D 认证失败审计（mcp_auth_failure）", () => {
  it("六态 reason 全部落到审计，且 patPrefix 只对 gxpat_ 形态截 14 字符", async () => {
    const rows = auditOf(readAudit(stack.env.auditDir), "mcp_auth_failure");
    const reasons = new Set(rows.map((r) => r.detail?.reason));
    for (const s of STATES) expect(reasons.has(s.reason), `审计缺 ${s.reason}`).toBe(true);

    // 带前缀的形态：patPrefix = 明文前 14 字符（不可认证，仅供同一坏 token 的关联分析）
    const forgedPrefixes = rows.filter((r) => r.detail?.reason === "unknown_token").map((r) => r.detail?.patPrefix);
    expect(forgedPrefixes).toContain(t.forged.slice(0, 14));
    // 非 PAT 形态：不截断任意 Authorization 值（patPrefix 必须缺省）
    const nonPat = rows.filter((r) => r.detail?.reason === "not_pat_prefix");
    expect(nonPat.length).toBeGreaterThan(0);
    expect(nonPat.every((r) => r.detail?.patPrefix === undefined)).toBe(true);
    // 无 Bearer：同样无 patPrefix
    expect(rows.filter((r) => r.detail?.reason === "missing_bearer").every((r) => r.detail?.patPrefix === undefined)).toBe(true);
  });

  it("审计零 token 泄漏：整份 audit.logl 不含任一明文（含随机段）", async () => {
    const text = JSON.stringify(readAudit(stack.env.auditDir));
    for (const tok of [t.expired, t.revoked, t.disabled, t.forged, stack.fx.pat.full.token]) {
      expect(text, `审计泄漏 token 前缀段`).not.toContain(tok.slice(6));
      expect(text).not.toContain(tok);
    }
  });
});
