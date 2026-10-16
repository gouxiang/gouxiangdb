// useActiveSession 纯判定单测（node 环境）：门控 × kind × token 快照矩阵。
import { describe, it, expect } from "vitest";
import { activeSessionSnapshot } from "./useActiveSession";

describe("activeSessionSnapshot", () => {
  it("门控关闭：无论 kind/token 一律 local（现网零变化）", () => {
    for (const kind of ["local", "remote"] as const) {
      for (const token of [null, "t"]) {
        expect(activeSessionSnapshot({ enabled: false, kind, token })).toBe("local");
      }
    }
  });

  it("门控开启：local 槽恒 local（即便无 token，放行与否仍由本地 gx-auth 决定）", () => {
    expect(activeSessionSnapshot({ enabled: true, kind: "local", token: null })).toBe("local");
    expect(activeSessionSnapshot({ enabled: true, kind: "local", token: "t" })).toBe("local");
  });

  it("门控开启：remote 槽有 token → remote，无 token → remote-empty", () => {
    expect(activeSessionSnapshot({ enabled: true, kind: "remote", token: "rt" })).toBe("remote");
    expect(activeSessionSnapshot({ enabled: true, kind: "remote", token: null })).toBe(
      "remote-empty",
    );
  });
});
