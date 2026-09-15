// M4/S3 shadow 纯函数单测：模式 gate（未知回 off / on 阶段降级 shadow）、drift 四象限分类、
// 环形缓冲覆盖顺序、id 哈希脱敏、shadowCompare 计数与结构化日志（不落明文 userId/响应体）、
// shadowReportError 吞错计数（日志不含错误明文）。无数据库、不 import Hono/guards。

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveAuthzEngineMode,
  effectiveAuthzMode,
  authzShadowActive,
  AUTHZ_ENFORCE_READY,
} from "../../../configAuthz.js";
import {
  DriftRegistry,
  classifyDrift,
  hashSubjectId,
  shadowCompare,
  shadowReportError,
  driftRegistry,
} from "../shadow.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GX_AUTHZ_ENGINE 模式解析（仿 flags.ts，未知保守回 off）", () => {
  it("缺省/空/未知值 -> off；大小写与空白归一", () => {
    expect(resolveAuthzEngineMode({})).toBe("off");
    expect(resolveAuthzEngineMode({ GX_AUTHZ_ENGINE: "" })).toBe("off");
    expect(resolveAuthzEngineMode({ GX_AUTHZ_ENGINE: "garbage" })).toBe("off");
    expect(resolveAuthzEngineMode({ GX_AUTHZ_ENGINE: "ONN" })).toBe("off");
    expect(resolveAuthzEngineMode({ GX_AUTHZ_ENGINE: "shadow" })).toBe("shadow");
    expect(resolveAuthzEngineMode({ GX_AUTHZ_ENGINE: "SHADOW" })).toBe("shadow");
    expect(resolveAuthzEngineMode({ GX_AUTHZ_ENGINE: " on " })).toBe("on");
  });

  it("阶段门未就绪（S3-S5）：on 一律降级 shadow；shadow/off 原样", () => {
    expect(AUTHZ_ENFORCE_READY).toBe(false); // S6 完成且翻门前恒 false
    expect(effectiveAuthzMode({ GX_AUTHZ_ENGINE: "on" })).toBe("shadow");
    expect(effectiveAuthzMode({ GX_AUTHZ_ENGINE: "shadow" })).toBe("shadow");
    expect(effectiveAuthzMode({ GX_AUTHZ_ENGINE: "off" })).toBe("off");
    expect(effectiveAuthzMode({})).toBe("off");
  });

  it("authzShadowActive 仅 shadow 为 true（on 降级后也算 active，off 恒 false）", () => {
    expect(authzShadowActive({ GX_AUTHZ_ENGINE: "off" })).toBe(false);
    expect(authzShadowActive({})).toBe(false);
    expect(authzShadowActive({ GX_AUTHZ_ENGINE: "shadow" })).toBe(true);
    expect(authzShadowActive({ GX_AUTHZ_ENGINE: "on" })).toBe(true); // 降级 shadow，仍对拍
  });
});

describe("classifyDrift 四象限", () => {
  it("两路一致 -> null", () => {
    expect(classifyDrift(true, true)).toBeNull();
    expect(classifyDrift(false, false)).toBeNull();
  });
  it("旧允新拒 -> DRIFT_OVERDENY（可用性风险）", () => {
    expect(classifyDrift(true, false)).toBe("DRIFT_OVERDENY");
  });
  it("旧拒新允 -> DRIFT_OVERALLOW（越权，零容忍）", () => {
    expect(classifyDrift(false, true)).toBe("DRIFT_OVERALLOW");
  });
});

describe("hashSubjectId 脱敏", () => {
  it("确定性、等长短哈希、不等于明文、不同主体不同哈希", () => {
    const a = hashSubjectId("user-123");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toBe(hashSubjectId("user-123"));
    expect(a).not.toContain("user-123");
    expect(hashSubjectId("user-456")).not.toBe(a);
  });
});

describe("DriftRegistry 计数与环形覆盖", () => {
  it("容量满后按时间先后（最旧->最新）覆盖并保持计数单调", () => {
    const reg = new DriftRegistry(3);
    const mk = (i: number) => ({
      ts: `${i}`, kind: "DRIFT_OVERDENY" as const, guard: "g", action: "r" as const,
      nodeId: `n${i}`, userHash: `h${i}`, oldAllowed: true, engineAllowed: false,
    });
    for (let i = 0; i < 5; i++) reg.record(mk(i));
    const snap = reg.snapshot();
    expect(snap.overDeny).toBe(5); // 计数不被覆盖影响
    expect(snap.recent.map((e) => e.nodeId)).toEqual(["n2", "n3", "n4"]); // 环形游标序，最旧->最新
    reg.reset();
    expect(reg.snapshot()).toMatchObject({ overDeny: 0, overAllow: 0, errors: 0, compared: 0, recent: [] });
  });

  it("overAllow/errors/unresolved/compared 分桶计数", () => {
    const reg = new DriftRegistry(2);
    reg.noteCompared();
    reg.noteCompared();
    reg.noteUnresolvedNode();
    reg.record({
      ts: "t", kind: "DRIFT_OVERALLOW", guard: "g", action: "u", nodeId: "n",
      userHash: "h", oldAllowed: false, engineAllowed: true,
    });
    reg.recordError({ ts: "t", guard: "g", action: "u", nodeId: "n", userHash: "h", message: "boom" });
    const s = reg.snapshot();
    expect(s).toMatchObject({ compared: 2, unresolvedNode: 1, overAllow: 1, errors: 1 });
    expect(s.recentErrors[0]!.message).toBe("boom"); // 错误明文只进进程内缓冲
  });
});

describe("shadowCompare 对拍 + 脱敏结构化日志", () => {
  afterEach(() => driftRegistry.reset());
  const ctx = { guard: "requireCanView", action: "r" as const, nodeId: "node_x", userId: "user-secret-1" };

  it("两路一致：仅增 compared，无 drift、不打日志", () => {
    driftRegistry.reset();
    const sink = vi.fn();
    const kind = shadowCompare(true, true, ctx, new Date("2026-09-15T00:00:00Z"), sink);
    expect(kind).toBeNull();
    expect(sink).not.toHaveBeenCalled();
    const s = driftRegistry.snapshot();
    expect(s.compared).toBe(1);
    expect(s.overDeny + s.overAllow).toBe(0);
  });

  it("overdeny / overallow 各自计数且日志键集合稳定、只含 userHash 不含明文 userId", () => {
    driftRegistry.reset();
    const denySink = vi.fn();
    shadowCompare(true, false, ctx, new Date("2026-09-15T00:00:00Z"), denySink);
    const denyLine = JSON.parse(denySink.mock.calls[0]![0] as string);
    expect(denyLine).toMatchObject({
      event: "authz_drift", kind: "DRIFT_OVERDENY", guard: "requireCanView",
      action: "r", nodeId: "node_x", old: true, engine: false,
    });
    expect(denyLine.userHash).toBe(hashSubjectId("user-secret-1"));
    expect(JSON.stringify(denyLine)).not.toContain("user-secret-1");

    const allowSink = vi.fn();
    shadowCompare(false, true, ctx, new Date("2026-09-15T00:00:01Z"), allowSink);
    expect(JSON.parse(allowSink.mock.calls[0]![0] as string).kind).toBe("DRIFT_OVERALLOW");

    const s = driftRegistry.snapshot();
    expect(s.overDeny).toBe(1);
    expect(s.overAllow).toBe(1);
  });
});

describe("shadowReportError 引擎故障吞错（fail-open 仅限观测层）", () => {
  afterEach(() => driftRegistry.reset());
  const ctx = { guard: "requireDocAccess", action: "u" as const, nodeId: "node_d", userId: "u-err" };

  it("记 error metric，结构化日志不含错误明文/堆栈/响应体", () => {
    driftRegistry.reset();
    const sink = vi.fn();
    shadowReportError(ctx, new Error("SELECT boom near secret_table"), new Date("2026-09-15T00:00:00Z"), sink);
    const line = sink.mock.calls[0]![0] as string;
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({ event: "authz_shadow_error", guard: "requireDocAccess", action: "u" });
    expect(line).not.toContain("secret_table");
    expect(line).not.toContain("u-err");
    const s = driftRegistry.snapshot();
    expect(s.errors).toBe(1);
    expect(s.recentErrors[0]!.message).toContain("boom"); // 明文仅在进程内缓冲供排查
  });

  it("非 Error 抛入也安全归整为字符串", () => {
    driftRegistry.reset();
    expect(() => shadowReportError(ctx, "string failure", new Date(), () => {})).not.toThrow();
    expect(driftRegistry.snapshot().errors).toBe(1);
  });
});
