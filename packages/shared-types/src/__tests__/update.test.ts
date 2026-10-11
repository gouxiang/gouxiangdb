import { describe, expect, it } from "vitest";
import {
  compareVersions,
  decideUpdate,
  parseVersion,
} from "../update.js";

// DESIGN docs/design/2026-10-app-update/DESIGN.md §4.1 / §4.2 强制表驱动覆盖。

describe("parseVersion", () => {
  it.each([
    ["0.2.3", 0, 2, 3, []],
    ["v0.2.3", 0, 2, 3, []],
    ["1.10.5", 1, 10, 5, []],
    ["0.2.3-rc1", 0, 2, 3, ["rc1"]], // 无点号：rc1 是单个非数字标识符
    ["0.2.3-rc.2", 0, 2, 3, ["rc", 2]],
    ["1.0.0-alpha.beta.3", 1, 0, 0, ["alpha", "beta", 3]],
    ["0.2.3+build.42", 0, 2, 3, []],
    ["0.0.0", 0, 0, 0, []], // minVersion 缺省值，必须仍合法
  ])("合法解析 %s", (input, major, minor, patch, pre) => {
    const v = parseVersion(input);
    expect(v.valid).toBe(true);
    expect([v.major, v.minor, v.patch]).toEqual([major, minor, patch]);
    expect(v.prerelease).toEqual(pre);
    expect(v.raw).toBe(input.trim());
  });

  it.each([
    ["0.0.0-dev"], // 兜底哨兵：核心 0.0.0 + 预发布
    ["0.0.0-rc1"],
    ["0.2"],
    ["0.2.x"],
    ["v2"],
    ["abc"],
    [""],
    ["0.2.3.4"],
    ["02.2.3"], // 前导 0 非 semver 规范
    ["v-0.2.3"],
  ])("非法 / 哨兵解析为 invalid：%s", (input) => {
    expect(parseVersion(input).valid).toBe(false);
  });

  it("非字符串输入安全返回 invalid", () => {
    expect(parseVersion(undefined as unknown as string).valid).toBe(false);
    expect(parseVersion(null as unknown as string).valid).toBe(false);
    expect(parseVersion(123 as unknown as string).valid).toBe(false);
  });
});

describe("compareVersions", () => {
  // [a, b, 期望]：-1 a<b，0 相等，1 a>b
  it.each([
    // 规则 2：三段数值比较（0.10.0 > 0.9.0，非字符串比较）
    ["0.9.0", "0.10.0", -1],
    ["0.10.0", "0.9.0", 1],
    ["1.0.0", "0.99.99", 1],
    ["1.2.3", "1.2.4", -1],
    ["1.2.4", "1.2.3", 1],
    ["2.0.0", "10.0.0", -1],
    // 规则 1：前导 v 剥离
    ["v0.2.3", "0.2.3", 0],
    ["v1.0.0", "1.0.0", 0],
    // 规则 4：相等
    ["0.2.3", "0.2.3", 0],
    // 规则 3：带后缀 < 不带后缀
    ["0.2.3-rc1", "0.2.3", -1],
    ["0.2.3", "0.2.3-rc1", 1],
    // rc 之间：数字段按数值（点号分隔的纯数字段；无点号的 rc10 是单个非数字标识，按 semver 走字典序）
    ["0.2.3-rc.1", "0.2.3-rc.2", -1],
    ["0.2.3-rc.9", "0.2.3-rc.10", -1],
    // rc 之间：数字段 < 非数字段
    ["1.0.0-1", "1.0.0-alpha", -1],
    // rc 之间：公共前缀相同时段数少的更小
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1], // 数字 < 非数字
    ["1.0.0-alpha.beta", "1.0.0-beta", -1],
    // 构建元数据不参与比较
    ["0.2.3+a", "0.2.3+b", 0],
    // 纯 0.0.0 合法可比较
    ["0.0.0", "0.0.1", -1],
  ])("compareVersions(%s, %s) = %s", (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want);
  });

  it.each([
    // 规则 6：当前版本不可解析（含 0.0.0-dev 兜底）
    ["0.0.0-dev", "0.2.3"],
    ["garbage", "0.2.3"],
    // 规则 7：清单版本不可解析
    ["0.2.3", "0.0.0-dev"],
    ["0.2.3", "bad"],
    ["", "0.2.3"],
  ])("任一不可解析返回 null：(%s, %s)", (a, b) => {
    expect(compareVersions(a, b)).toBeNull();
  });

  // 规则 8 由调用方用 compareVersions(current, minVersion) 计算：临界（等于 / 低一版）。
  describe("minVersion 临界", () => {
    it("当前等于 minVersion → 可升级（cmp=0，不低于下限）", () => {
      expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    });
    it("当前低一版 → cmp<0，below min（不给下载）", () => {
      expect(compareVersions("0.0.9", "0.1.0")).toBe(-1);
    });
    it("当前高于 minVersion → cmp>0", () => {
      expect(compareVersions("0.2.2", "0.1.0")).toBe(1);
    });
  });
});

describe("decideUpdate", () => {
  const base = {
    currentVersion: "0.2.2",
    candidateVersion: "0.2.3",
    allowPrerelease: false,
    candidatePrerelease: false,
  };

  it("候选更高且正式 → upgrade", () => {
    expect(decideUpdate(base)).toBe("upgrade");
  });

  it("规则 4：相等 → latest，即使 notes 更新也不提示", () => {
    expect(decideUpdate({ ...base, currentVersion: "0.2.3" })).toBe("latest");
  });

  it("规则 5：候选更低（降级）→ downgrade，不提示", () => {
    expect(decideUpdate({ ...base, candidateVersion: "0.2.1" })).toBe(
      "downgrade",
    );
  });

  it("前导 v 不影响判断", () => {
    expect(
      decideUpdate({ ...base, currentVersion: "v0.2.2", candidateVersion: "v0.2.3" }),
    ).toBe("upgrade");
  });

  it("规则 9：预发布默认不纳入 → latest（不提示）", () => {
    expect(
      decideUpdate({ ...base, candidateVersion: "0.2.3-rc1", candidatePrerelease: true }),
    ).toBe("latest");
  });

  it("规则 9：ALLOW_PRERELEASE 放行后 rc 更高 → upgrade", () => {
    expect(
      decideUpdate({
        ...base,
        allowPrerelease: true,
        candidateVersion: "0.2.3-rc1",
        candidatePrerelease: true,
      }),
    ).toBe("upgrade");
  });

  it("正式版优先于同号 rc（放行预发布时也成立）", () => {
    expect(
      decideUpdate({
        currentVersion: "0.2.3-rc1",
        candidateVersion: "0.2.3",
        allowPrerelease: true,
        candidatePrerelease: false,
      }),
    ).toBe("upgrade");
  });

  it("规则 6：当前为 0.0.0-dev 兜底 → incomparable，绝不产生升级提示", () => {
    expect(
      decideUpdate({ ...base, currentVersion: "0.0.0-dev" }),
    ).toBe("incomparable");
  });

  it("当前版本被改坏 → incomparable（fail-safe）", () => {
    expect(
      decideUpdate({ ...base, currentVersion: "vX" }),
    ).toBe("incomparable");
  });

  it("规则 7：候选版本非法 → incomparable", () => {
    expect(
      decideUpdate({ ...base, candidateVersion: "0.2" }),
    ).toBe("incomparable");
  });

  it("rc.9 → rc.10 按数值升级（点号分隔的纯数字段，非字符串比较）", () => {
    expect(
      decideUpdate({
        currentVersion: "0.2.3-rc.9",
        candidateVersion: "0.2.3-rc.10",
        allowPrerelease: true,
        candidatePrerelease: true,
      }),
    ).toBe("upgrade");
  });

  it("预发布候选在放行后但版本更低 → downgrade", () => {
    expect(
      decideUpdate({
        currentVersion: "0.2.3",
        candidateVersion: "0.2.3-rc1",
        allowPrerelease: true,
        candidatePrerelease: true,
      }),
    ).toBe("downgrade");
  });
});
