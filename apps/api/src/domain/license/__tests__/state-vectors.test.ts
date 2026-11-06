/**
 * 05-TEST-VECTORS.json 锁定向量：状态机 8 条 + suspendList 2 条。
 * 客户端与授权中心各自跑同一份 JSON；改规则必须同时改夹具。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  currentEntitlement,
  suspendList,
  FREE_SEATS,
  GRACE_SECONDS,
  type EntitlementView,
  type SeatUser,
} from "../state.js";
import type { Entitlement } from "../verify.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(here, "__fixtures__/05-TEST-VECTORS.json");
const doc = JSON.parse(readFileSync(vectorsPath, "utf-8")) as {
  constants: { FREE_SEATS: number; GRACE_SECONDS: number; T0: number };
  vectors: Array<Record<string, any>>;
  suspendList: Array<Record<string, any>>;
};

/** 解析 "T0" / "T0+400d" / "T0-10d" 表达式为 unix 秒。 */
function tExpr(expr: string | number, t0: number): number {
  if (typeof expr === "number") return expr;
  const m = /^T0(?:([+-])(\d+)d)?$/.exec(expr.trim());
  if (!m) throw new Error(`bad time expr: ${expr}`);
  if (!m[1]) return t0;
  const days = Number(m[2]);
  return t0 + (m[1] === "+" ? days : -days) * 86400;
}

function makeEntitlement(v: Record<string, any>, t0: number): Entitlement | null {
  if (!v.hasEntitlement) return null;
  return {
    product: "gouxiangdb",
    edition: "business",
    licenseId: "lic-test",
    licensedTo: "向量客户",
    seats: v.seats ?? 10,
    issuedAt: t0 - 86400,
    expiresAt: tExpr(v.expiresAt ?? "T0+400d", t0),
    fingerprint: "f".repeat(64),
    nonce: "nonce",
    features: {},
    version: 1,
    kid: "da469cd3",
    offline: false,
    revoked: v.revoked === true,
  };
}

describe("license state machine — 05-TEST-VECTORS", () => {
  it("常量与夹具一致", () => {
    expect(FREE_SEATS).toBe(doc.constants.FREE_SEATS);
    expect(GRACE_SECONDS).toBe(doc.constants.GRACE_SECONDS);
  });

  for (const vec of doc.vectors) {
    it(`状态机向量 ${vec.id}: ${vec.desc}`, () => {
      const t0 = doc.constants.T0;
      const view: EntitlementView = currentEntitlement({
        mode: vec.input.mode,
        entitlement: makeEntitlement(vec.input, t0),
        now: tExpr(vec.input.now, t0),
        everCommercial: vec.input.everCommercial === true,
        grandfathered: vec.input.grandfathered === true,
      });
      expect(view.verdict).toBe(vec.expect.verdict);
      const expectedSeats = vec.expect.seats === "Infinity" ? Infinity : vec.expect.seats;
      expect(view.seats).toBe(expectedSeats);
    });
  }
});

describe("license suspendList — 05-TEST-VECTORS", () => {
  for (const item of doc.suspendList) {
    it(`占席向量 ${item.id}: ${item.desc}`, () => {
      const users = item.users as SeatUser[];
      const { keep, suspend } = suspendList(users, item.seats);
      if (item.expect.keep) {
        expect([...keep].sort()).toEqual([...item.expect.keep].sort());
      }
      if (item.expect.suspend) {
        expect([...suspend].sort()).toEqual([...item.expect.suspend].sort());
      }
      if (item.expect.keepContains) {
        for (const id of item.expect.keepContains) expect(keep.has(id)).toBe(true);
      }
      if (item.expect.suspendContains) {
        for (const id of item.expect.suspendContains) expect(suspend.has(id)).toBe(true);
      }
      // 不重不漏：keep 与 suspend 恰好分割全集。
      expect(keep.size + suspend.size).toBe(users.length);
      for (const u of users) {
        expect(keep.has(u.id) !== suspend.has(u.id)).toBe(true);
      }
    });
  }
});
